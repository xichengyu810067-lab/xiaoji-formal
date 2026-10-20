'use strict';

// Host operation context: background job runs, the context of each Discord event, and what the ready
// event does and does not hand to the handlers and timers it starts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Events } = require('discord.js');

const {
  captureDiscordEventContext,
  getHostOperationContext,
  runWithBackgroundContext,
  runWithHostOperationContext,
} = require('../src/platform/hostOperationContext');
const { createPublicEffectAuthority, snowflakeTimestamp } = require('../src/platform/publicEffectGrant');
const { registerEvents } = require('../src/handlers/registerEvents');
const { loadTestControlPolicy } = require('../src/platform/testControlPolicy');
const { IDS, createFixture } = require('./testControlSupport');

const SRC = path.join(__dirname, '..', 'src');
const BOT_ID = '10000000000000001';
const GUILD_A = '10000000000000002';
const GUILD_B = '10000000000000003';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// A context that carries a grant, as a messageCreate event does.
const EVENT_CONTEXT_WITH_GRANT = Object.freeze({
  sourceEventId: '10000000000000020', hostPurpose: 'discord.message',
  publicEffectEventGrant: Object.freeze({ kind: 'synthetic-grant' }),
});
const SCHEDULED_JOBS = Object.freeze([
  ['work.payroll', 5 * 60 * 1000],
  ['work.reminder', 60 * 60 * 1000],
  ['work.expired-tasks', 15 * 60 * 1000],
  ['work.penalty-announcement', 15 * 60 * 1000],
  ['bank.interest', 15 * 60 * 1000],
  ['casino.loan-interest', 15 * 60 * 1000],
  ['casino.blackjack-refund', 5 * 60 * 1000],
  ['venue.expired-orders', 15 * 60 * 1000],
  ['word-chain.reaction-outbox', 30 * 1000],
  ['number-chain.reaction-outbox', 30 * 1000],
]);

function readyContextFor(botId) {
  return { sourceEventId: botId, actorId: botId, hostPurpose: 'discord.ready', scope: `bot:${botId}` };
}

function assertBackground(context, job) {
  assert.ok(context, `${job} must run in a background context`);
  assert.deepEqual(Object.keys(context).sort(), ['hostPurpose', 'scope', 'sourceEventId', 'startedAtMs'], job);
  assert.equal(context.hostPurpose, `background.${job}`);
  assert.equal(context.scope, `background:${job}`);
  assert.match(context.sourceEventId, UUID_V4);
  assert.ok(Number.isSafeInteger(context.startedAtMs) && context.startedAtMs >= 0, job);
}

function readyClient({ botId = BOT_ID, guilds = [[GUILD_A, 1_700_000_000_000], [GUILD_B, 1_700_000_000_001]] } = {}) {
  const client = new EventEmitter();
  client.user = { id: botId, tag: 'xiaoji-test#0001' };
  client.guilds = { cache: new Map(guilds.map(([id, joinedTimestamp]) => [id, { id, joinedTimestamp }])) };
  client.commands = new Map();
  return client;
}

function stubModule(t, file, exports) {
  const filename = require.resolve(file);
  const previous = require.cache[filename];
  const stub = new Module(filename, module);
  stub.filename = filename;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[filename] = stub;
  t.after(() => {
    if (previous) require.cache[filename] = previous;
    else delete require.cache[filename];
  });
}

// registerEvents reads event modules from a directory; each file here resolves to the
// given module object through the require cache.
function registerSyntheticEvents(t, events, authority, clientOptions) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-host-context-events-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [file, event] of Object.entries(events)) {
    const filePath = path.join(directory, file);
    fs.writeFileSync(filePath, '');
    stubModule(t, filePath, event);
  }
  const client = readyClient(clientOptions);
  registerEvents(client, directory, { publicEffectAuthority: authority });
  return client;
}

function httpGet(server) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (response) => {
      response.resume();
      response.on('end', resolve);
    }).on('error', reject);
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
}

async function waitUntil(predicate, { timeoutMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('each run of a background job gets a fresh sourceEventId and no actor or grant', async () => {
  const seen = [];
  for (let run = 0; run < 2; run += 1) {
    await runWithBackgroundContext('work.payroll', async () => {
      seen.push(getHostOperationContext());
      await new Promise((resolve) => setImmediate(resolve));
      seen.push(getHostOperationContext());
    });
  }
  for (const context of seen) assertBackground(context, 'work.payroll');
  assert.ok(Object.isFrozen(seen[0]));
  // The same run keeps its ID across await; two runs never share one.
  assert.equal(seen[0].sourceEventId, seen[1].sourceEventId);
  assert.equal(seen[2].sourceEventId, seen[3].sourceEventId);
  assert.notEqual(seen[0].sourceEventId, seen[2].sourceEventId);
  assert.equal(getHostOperationContext(), null);
});

test('each background run fixes its own start time once, as a safe integer read from the clock', async (t) => {
  const clock = t.mock.method(Date, 'now', () => 1_700_000_000_123);
  const first = await runWithBackgroundContext('work.payroll', async () => {
    const atStart = getHostOperationContext();
    clock.mock.mockImplementation(() => 1_700_000_009_999);
    await new Promise((resolve) => setImmediate(resolve));
    // Later in the same run the value stays the one read at the start.
    assert.equal(getHostOperationContext().startedAtMs, atStart.startedAtMs);
    return atStart;
  });
  assertBackground(first, 'work.payroll');
  assert.equal(first.startedAtMs, 1_700_000_000_123);
  const second = runWithBackgroundContext('work.payroll', () => getHostOperationContext());
  assert.equal(second.startedAtMs, 1_700_000_009_999);
  assert.notEqual(second.sourceEventId, first.sourceEventId);
  // A clock that does not give a safe, non-negative integer stops the run before it starts.
  for (const invalid of [Number.NaN, 1.5, -1, Number.MAX_SAFE_INTEGER + 2, '1700000000000']) {
    clock.mock.mockImplementation(() => invalid);
    assert.throws(() => runWithBackgroundContext('work.payroll', () => assert.fail('must not run')),
      TypeError, String(invalid));
  }
});

test('a background run replaces the surrounding event context and its grant', async () => {
  const inside = runWithHostOperationContext(EVENT_CONTEXT_WITH_GRANT,
    () => runWithBackgroundContext('poll.end', () => getHostOperationContext()));
  assertBackground(inside, 'poll.end');
  const timerContext = await runWithBackgroundContext('reminder.deliver',
    () => new Promise((resolve) => setTimeout(() => resolve(getHostOperationContext()), 0)));
  assertBackground(timerContext, 'reminder.deliver');
});

test('background job names and callbacks are checked before anything runs', () => {
  for (const job of ['', 'Work', 'work payroll', 'work..payroll', '.work', 'work.', 'work-', '1work',
    'work/payroll', 'a'.repeat(65), null, undefined, 42, {}]) {
    assert.throws(() => runWithBackgroundContext(job, () => assert.fail('must not run')), TypeError, String(job));
  }
  assert.throws(() => runWithBackgroundContext('work.payroll'), TypeError);
  assert.equal(runWithBackgroundContext('a'.repeat(64), () => 'returned'), 'returned');
});

test('the ready context is the bot\'s own and carries no grant; nothing hands out guild-join grants for it', () => {
  const authority = createPublicEffectAuthority();
  const client = readyClient();
  assert.deepEqual(captureDiscordEventContext(Events.ClientReady, [client], { publicEffectAuthority: authority }),
    readyContextFor(BOT_ID));
  // Without a user ID, or without a guild cache, there is no ready context at all.
  assert.equal(captureDiscordEventContext(Events.ClientReady,
    [{ user: { id: 'not-a-snowflake' }, guilds: client.guilds }], { publicEffectAuthority: authority }), null);
  assert.equal(captureDiscordEventContext(Events.ClientReady, [{ user: { id: BOT_ID } }],
    { publicEffectAuthority: authority }), null);
  // Guilds are not reviewed at startup any more: there are no ready grants to capture or revoke.
  const hostContext = require('../src/platform/hostOperationContext');
  assert.equal(hostContext.captureReadyGuildJoinGrants, undefined);
  assert.equal(hostContext.revokeGuildJoinGrants, undefined);
});

test('registerEvents runs ready in the bot\'s context with the client alone, and what ready starts inherits no grant', async (t) => {
  const authority = createPublicEffectAuthority();
  const observed = {};
  let server = null;
  let settle;
  const readySettled = new Promise((resolve) => { settle = resolve; });
  t.after(() => close(server));
  const ready = {
    name: Events.ClientReady,
    once: true,
    async execute(...args) {
      observed.args = args;
      observed.context = getHostOperationContext();
      // Started inside the ready context: a timer that reads its context only after ready
      // has settled, and an HTTP server whose handler runs later.
      observed.lateTimer = new Promise((resolve) => setTimeout(async () => {
        await readySettled;
        resolve(getHostOperationContext());
      }, 0));
      server = http.createServer((request, response) => {
        observed.httpContext = getHostOperationContext();
        response.end('ok');
      });
      await listen(server);
    },
  };
  const client = registerSyntheticEvents(t, { 'ready.js': ready }, authority);
  await client.listeners(Events.ClientReady)[0](client);
  settle();

  assert.deepEqual(observed.args, [client]);
  assert.deepEqual(observed.context, readyContextFor(BOT_ID));
  // After ready, the timer and the HTTP handler see only the grant-free ready context.
  assert.deepEqual(await observed.lateTimer, readyContextFor(BOT_ID));
  await httpGet(server);
  assert.deepEqual(observed.httpContext, readyContextFor(BOT_ID));
});

test('a failing ready handler keeps its failure, asynchronous or synchronous', async (t) => {
  for (const mode of ['async', 'sync']) {
    const authority = createPublicEffectAuthority();
    const failure = new Error(`synthetic ${mode} ready failure`);
    const ready = {
      name: Events.ClientReady,
      once: true,
      execute: mode === 'async'
        ? async () => { throw failure; }
        : () => { throw failure; },
    };
    const client = registerSyntheticEvents(t, { 'ready.js': ready }, authority);
    const listener = client.listeners(Events.ClientReady)[0];
    if (mode === 'async') await assert.rejects(listener(client), (error) => error === failure);
    else assert.throws(() => listener(client), (error) => error === failure);
  }
});

// A guild the bot joined: the guild is the source event together with the time the bot joined it, the actor is
// the bot, and the grant of the join (which nothing consumes in the public core any more) is carried when the join
// time is known. The notice of the join needs none of it: a join time Discord did not give still has a context.
test('a guild join is one source event of its own, acted by the bot, in the scope of the guild', () => {
  const authority = createPublicEffectAuthority();
  const joinedTimestamp = 1_700_000_000_000;
  const guild = { id: GUILD_A, joinedTimestamp, client: { user: { id: BOT_ID } } };
  const context = captureDiscordEventContext(Events.GuildCreate, [guild], { publicEffectAuthority: authority });
  assert.deepEqual(Object.keys(context).sort(),
    ['actorId', 'guildId', 'hostPurpose', 'scope', 'sourceEventId', 'trustedGuildJoinGrant']);
  assert.equal(context.sourceEventId, `${GUILD_A}.${joinedTimestamp}`);
  assert.equal(context.guildId, GUILD_A);
  assert.equal(context.actorId, BOT_ID);
  assert.equal(context.hostPurpose, 'discord.guildCreate');
  assert.equal(context.scope, `guild:${GUILD_A}`);
  assert.equal(authority.consumeGuildJoin(context.trustedGuildJoinGrant).sourceNamespace, 'discord.guildCreate');
  // A repeat of the same join (a reconnect) is the same source event; a join at another time is another one.
  const again = captureDiscordEventContext(Events.GuildCreate, [guild], { publicEffectAuthority: authority });
  assert.equal(again.sourceEventId, context.sourceEventId);
  const rejoined = captureDiscordEventContext(Events.GuildCreate,
    [{ ...guild, joinedTimestamp: joinedTimestamp + 5_000 }], { publicEffectAuthority: authority });
  assert.notEqual(rejoined.sourceEventId, context.sourceEventId);
  // The join time can also come from a Date.
  const fromDate = captureDiscordEventContext(Events.GuildCreate,
    [{ id: GUILD_A, joinedAt: new Date(joinedTimestamp), client: guild.client }], { publicEffectAuthority: authority });
  assert.equal(fromDate.sourceEventId, context.sourceEventId);
});

test('a guild join whose time or authority is missing still has a context, without a grant', () => {
  const seenAtMs = 1_700_000_000_777;
  const now = () => seenAtMs;
  const client = { user: { id: BOT_ID } };
  // No authority: the context is the same, without a grant.
  const noAuthority = captureDiscordEventContext(Events.GuildCreate,
    [{ id: GUILD_A, joinedTimestamp: 1_700_000_000_000, client }], { now });
  assert.equal(noAuthority.sourceEventId, `${GUILD_A}.1700000000000`);
  assert.equal('trustedGuildJoinGrant' in noAuthority, false);
  // No join time at all: the moment the event was seen stands in for it.
  const authority = createPublicEffectAuthority();
  for (const joinedTimestamp of [undefined, null, Number.NaN, -1, 1.5]) {
    const context = captureDiscordEventContext(Events.GuildCreate,
      [{ id: GUILD_A, joinedTimestamp, client }], { publicEffectAuthority: authority, now });
    assert.deepEqual(context, {
      sourceEventId: `${GUILD_A}.${seenAtMs}`,
      guildId: GUILD_A,
      actorId: BOT_ID,
      hostPurpose: 'discord.guildCreate',
      scope: `guild:${GUILD_A}`,
    }, String(joinedTimestamp));
  }
  // Without a guild, a bot, or (when the join time is unknown) a usable clock there is no context.
  for (const subject of [{ id: 'guild', joinedTimestamp: 1, client }, { id: GUILD_A, client: { user: { id: 'bot' } } },
    { id: GUILD_A, client: {} }, null, 'guild']) {
    assert.equal(captureDiscordEventContext(Events.GuildCreate, [subject], { now }), null, JSON.stringify(subject));
  }
  assert.equal(captureDiscordEventContext(Events.GuildCreate, [{ id: GUILD_A, client }], { now: () => Number.NaN }), null);
});

test('other events keep their own captured context', async (t) => {
  const authority = createPublicEffectAuthority();
  let seen = null;
  const messageEvent = { name: Events.MessageCreate, async execute() { seen = getHostOperationContext(); } };
  const client = registerSyntheticEvents(t, { 'messageCreate.js': messageEvent }, authority);
  const message = {
    id: '10000000000000010', author: { id: '10000000000000011' }, channelId: '10000000000000012',
    guildId: GUILD_A, createdTimestamp: 1_700_000_000_000, client: { user: { id: BOT_ID } },
  };
  await client.listeners(Events.MessageCreate)[0](message);
  assert.equal(seen.hostPurpose, 'discord.message');
  assert.equal(seen.sourceEventId, message.id);
  assert.equal(authority.inspectEvent(seen.publicEffectEventGrant).messageId, message.id);
});

// A member who leaves: no event ID of its own that is a snowflake, so the source event is the guild,
// the member and the moment; the actor is the bot, as for guildCreate, not one watermark row per member.
test('a guild member leave is one source event of its own, acted by the bot, in the scope of the guild', () => {
  const memberId = '10000000000000060';
  const member = {
    id: memberId, guild: { id: GUILD_A }, client: { user: { id: BOT_ID } }, partial: true, joinedTimestamp: null,
  };
  const leftAtMs = 1_700_000_000_123;
  const context = captureDiscordEventContext(Events.GuildMemberRemove, [member], { now: () => leftAtMs });
  assert.deepEqual(context, {
    sourceEventId: `${GUILD_A}.${memberId}.${leftAtMs}`,
    guildId: GUILD_A,
    actorId: BOT_ID,
    hostPurpose: 'discord.guildMemberRemove',
    scope: `guild:${GUILD_A}`,
  });
  assert.ok(Object.isFrozen(context));
  // Not a snowflake (so no time is read from it), and carrying no grant of any kind.
  assert.match(context.sourceEventId, /^\d{17,20}\.\d{17,20}\.\d+$/u);
  assert.equal(snowflakeTimestamp(context.sourceEventId), null);
  assert.equal('publicEffectEventGrant' in context, false);
  // Another leave of the same member is another source event; the same moment is the same one.
  const later = captureDiscordEventContext(Events.GuildMemberRemove, [member], { now: () => leftAtMs + 1 });
  assert.notEqual(later.sourceEventId, context.sourceEventId);
  assert.equal(captureDiscordEventContext(Events.GuildMemberRemove, [member], { now: () => leftAtMs }).sourceEventId,
    context.sourceEventId);
  // The member's ID can come from its user, and the real clock is the default.
  const fromUser = captureDiscordEventContext(Events.GuildMemberRemove,
    [{ guild: { id: GUILD_B }, user: { id: memberId }, client: { user: { id: BOT_ID } } }]);
  assert.equal(fromUser.guildId, GUILD_B);
  assert.match(fromUser.sourceEventId, new RegExp(`^${GUILD_B}\\.${memberId}\\.\\d+$`, 'u'));
});

test('a guild member leave without a usable guild, member, bot or clock has no context at all', () => {
  const good = { id: '10000000000000060', guild: { id: GUILD_A }, client: { user: { id: BOT_ID } } };
  const now = () => 1_700_000_000_123;
  const capture = (subject, options = { now }) => captureDiscordEventContext(Events.GuildMemberRemove, [subject], options);
  assert.notEqual(capture(good), null);
  for (const subject of [
    { ...good, guild: null }, { ...good, guild: { id: 'guild' } }, { ...good, guild: { id: '' } },
    { ...good, id: 'member' }, { ...good, id: null }, { ...good, client: null },
    { ...good, client: { user: { id: 'bot' } } }, null, 'member',
  ]) {
    assert.equal(capture(subject), null, JSON.stringify(subject));
  }
  for (const invalid of [() => Number.NaN, () => -1, () => 1.5, () => '1700000000000', () => { throw new Error('x'); }]) {
    assert.equal(capture(good, { now: invalid }), null, String(invalid));
  }
  assert.equal(captureDiscordEventContext(Events.GuildMemberRemove, []), null);
});

test('registerEvents runs the guild member leave listener in the context of that leave', async (t) => {
  const authority = createPublicEffectAuthority();
  const seen = [];
  const leaveEvent = { name: Events.GuildMemberRemove, async execute() { seen.push(getHostOperationContext()); } };
  const client = registerSyntheticEvents(t, { 'guildMemberRemove.js': leaveEvent }, authority);
  const memberId = '10000000000000061';
  const member = { id: memberId, guild: { id: GUILD_A }, client: { user: { id: BOT_ID } }, partial: true };
  const before = Date.now();
  await client.listeners(Events.GuildMemberRemove)[0](member);
  const after = Date.now();
  assert.equal(seen.length, 1);
  const [context] = seen;
  assert.deepEqual(Object.keys(context).sort(), ['actorId', 'guildId', 'hostPurpose', 'scope', 'sourceEventId']);
  assert.equal(context.hostPurpose, 'discord.guildMemberRemove');
  assert.equal(context.actorId, BOT_ID);
  assert.equal(context.scope, `guild:${GUILD_A}`);
  const [, , leftAt] = context.sourceEventId.split('.');
  assert.ok(Number(leftAt) >= before && Number(leftAt) <= after);
  assert.equal(getHostOperationContext(), null);
});

// Replaces every service ready.js starts with a recorder, so the real ready.js wiring can
// run without data files, Discord or timers that outlive the test.
function createReadyHarness() {
  const calls = [];
  const errors = [];
  const warnings = [];
  const infos = [];
  const servers = [];
  const hookPayloads = [];
  let settle;
  const readySettled = new Promise((resolve) => { settle = resolve; });
  const harness = { calls, errors, warnings, infos, servers, hookPayloads, lateTimer: null, markSettled: () => settle() };
  const record = (label, extra = {}) => { calls.push({ label, context: getHostOperationContext(), ...extra }); };
  const job = (label) => async () => record(label);
  harness.extensionHost = (client) => ({
    async runHook(name, payload) {
      record(`extension.${name}`, { payloadKeys: Object.keys(payload).sort(), sameClient: payload.client === client });
      hookPayloads.push(payload);
      // Even when called from an event context that holds a grant, the extension's
      // scheduled task does not inherit it.
      runWithHostOperationContext(EVENT_CONTEXT_WITH_GRANT,
        () => payload.scheduleStartupTask('私有擴充排程', () => record('extension.task'), 1_000));
      return [];
    },
  });
  harness.stubs = {
    'services/conversationHistoryService.js': {
      clearExpiredConversationHistory: job('conversation.clear'),
      startConversationHistoryCleanupScheduler: job('conversation.scheduler'),
    },
    'systems/games/board/core/boardRuntimeRegistry.js': { getBoardRuntime: () => ({ startLifecycle: job('board.start') }) },
    'services/gameService.js': { resumePendingGameRewards: job('game.rewards') },
    'services/gameServer.js': { startGameServer: job('game.server') },
    'services/publicStatusServer.js': {
      async startPublicStatusServer() {
        record('status.server');
        const server = http.createServer((request, response) => {
          record('status.http');
          response.end('ok');
        });
        servers.push(server);
        await listen(server);
      },
    },
    'services/statusSnapshotPublisher.js': { startStatusSnapshotPublisher: job('status.publisher') },
    'services/dailyRiddleService.js': { startDailyRiddleScheduler: job('riddle.scheduler') },
    'services/dailyDiscussionService.js': { startDailyDiscussionScheduler: job('discussion.scheduler') },
    'services/pollService.js': {
      async restoreActivePolls() {
        record('polls.restore');
        harness.lateTimer = new Promise((resolve) => setTimeout(async () => {
          await readySettled;
          resolve(getHostOperationContext());
        }, 0));
      },
    },
    'services/reminderService.js': { restoreActiveReminders: job('reminders.restore') },
    'services/releaseAnnouncementService.js': { startReleaseAnnouncementScheduler: job('release.scheduler') },
    'services/workService.js': {
      processDueJobs: job('work.payroll'),
      processWorkReminders: job('work.reminder'),
      processExpiredWorkTasks: job('work.expired-tasks'),
      processWorkPenaltyAnnouncements: job('work.penalty-announcement'),
    },
    'services/bankService.js': { processBankInterest: job('bank.interest') },
    'services/casinoService.js': {
      processCasinoLoanInterest: job('casino.loan-interest'),
      processExpiredBlackjackSessions: job('casino.blackjack-refund'),
    },
    'services/venueService.js': { processExpiredVenueOrderItems: job('venue.expired-orders') },
    'services/wordChainService.js': { processWordChainReactionOutbox: job('word-chain.reaction-outbox') },
    'services/numberChainService.js': { processNumberChainReactionOutbox: job('number-chain.reaction-outbox') },
    'utils/logger.js': {
      info: (...args) => infos.push(args),
      warn: (...args) => warnings.push(args),
      error: (...args) => errors.push(args),
    },
  };
  return harness;
}

function loadReadyWithStubs(t, stubs) {
  for (const [relative, exports] of Object.entries(stubs)) stubModule(t, path.join(SRC, relative), exports);
  const readyPath = require.resolve(path.join(SRC, 'events', 'ready.js'));
  const previous = require.cache[readyPath];
  delete require.cache[readyPath];
  t.after(() => {
    if (previous) require.cache[readyPath] = previous;
    else delete require.cache[readyPath];
  });
  return require(readyPath);
}

test('ready.js starts HTTP services and the extension hook without a context, runs every scheduled job in its own background context, and leaves no guild to review or leave', async (t) => {
  const authority = createPublicEffectAuthority();
  const harness = createReadyHarness();
  t.after(() => Promise.all(harness.servers.map(close)));
  const intervals = [];
  const intervalMock = t.mock.method(globalThis, 'setInterval', (callback, ms) => {
    intervals.push({ callback, ms });
    return { unref() {}, ref() {} };
  });
  const ready = loadReadyWithStubs(t, harness.stubs);
  const client = registerSyntheticEvents(t, { 'ready.js': ready }, authority);
  client.extensionHost = harness.extensionHost(client);

  await client.listeners(Events.ClientReady)[0](client);
  const startup = harness.calls.slice();
  harness.markSettled();

  // The startup order, including where the extension hook runs, is unchanged.
  assert.deepEqual(startup.map((call) => call.label), [
    'conversation.clear', 'conversation.scheduler', 'board.start', 'game.rewards', 'game.server', 'status.server',
    'status.publisher', 'riddle.scheduler', 'discussion.scheduler', 'polls.restore', 'reminders.restore',
    'release.scheduler', 'extension.ready', 'extension.task', ...SCHEDULED_JOBS.map(([job]) => job),
  ]);
  // Nothing of ready reviews the guilds the bot is in, and no scheduled job leaves one.
  assert.equal(startup.some((call) => /^audit\./u.test(call.label)), false);
  assert.equal(SCHEDULED_JOBS.some(([job]) => /^audit\./u.test(job)), false);
  // The start says nothing of a review: no guild is counted as unknown, and nothing asks the Owner to review one.
  assert.deepEqual(harness.warnings, []);
  assert.equal(harness.infos.some(([line]) => /審核|未知|lineage/iu.test(String(line))), false);
  const byLabel = new Map(startup.map((call) => [call.label, call]));
  for (const label of ['game.server', 'status.server', 'extension.ready', 'extension.task']) {
    assert.equal(byLabel.get(label).context, null, label);
  }
  for (const label of ['conversation.clear', 'conversation.scheduler', 'board.start', 'game.rewards',
    'status.publisher', 'riddle.scheduler', 'discussion.scheduler', 'polls.restore', 'reminders.restore',
    'release.scheduler']) {
    assert.deepEqual(byLabel.get(label).context, readyContextFor(BOT_ID), label);
  }
  for (const [job] of SCHEDULED_JOBS) assertBackground(byLabel.get(job).context, job);
  assert.equal(new Set(SCHEDULED_JOBS.map(([job]) => byLabel.get(job).context.sourceEventId)).size, SCHEDULED_JOBS.length);

  // The hook payload is the same as before.
  const hook = byLabel.get('extension.ready');
  assert.deepEqual(hook.payloadKeys, ['client', 'runStartupTask', 'scheduleStartupTask']);
  assert.equal(hook.sameClient, true);

  // Schedule intervals are unchanged, and a later run of the same job gets a new sourceEventId.
  assert.deepEqual(intervals.map((interval) => interval.ms), [1_000, ...SCHEDULED_JOBS.map(([, ms]) => ms)]);
  const payrollIndex = 1 + SCHEDULED_JOBS.findIndex(([job]) => job === 'work.payroll');
  intervals[payrollIndex].callback();
  intervals[payrollIndex].callback();
  const payrollRuns = harness.calls.filter((call) => call.label === 'work.payroll');
  assert.equal(payrollRuns.length, 3);
  for (const run of payrollRuns) assertBackground(run.context, 'work.payroll');
  assert.equal(new Set(payrollRuns.map((run) => run.context.sourceEventId)).size, 3);

  // After ready, a timer it started and the status HTTP handler read no grant.
  assert.deepEqual(await harness.lateTimer, readyContextFor(BOT_ID));
  await httpGet(harness.servers[0]);
  assert.equal(harness.calls.find((call) => call.label === 'status.http').context, null);

  // With real timers, a task the extension schedules from an event context still runs
  // without any context on every interval.
  intervalMock.mock.restore();
  const realRuns = [];
  const timer = runWithHostOperationContext(EVENT_CONTEXT_WITH_GRANT, () => harness.hookPayloads[0]
    .scheduleStartupTask('私有擴充排程', () => { realRuns.push(getHostOperationContext()); }, 5));
  try {
    await waitUntil(() => realRuns.length >= 3);
  } finally {
    clearInterval(timer);
  }
  assert.deepEqual(realRuns.slice(0, 3), [null, null, null]);
  assert.deepEqual(harness.errors, []);
});

test('test-control ready keeps its four reviewed jobs and runs the reaction outboxes as background jobs', async (t) => {
  const fixture = createFixture({
    XIAOJI_TEST_ALLOWED_JOBS: 'poll_restore,reminder_restore,word_chain_reaction_outbox,number_chain_reaction_outbox',
  });
  t.after(() => fixture.cleanup());
  const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
  const authority = createPublicEffectAuthority();
  const harness = createReadyHarness();
  t.after(() => harness.markSettled());
  const ready = loadReadyWithStubs(t, harness.stubs);
  const client = registerSyntheticEvents(t, { 'ready.js': ready }, authority,
    { botId: IDS.app, guilds: [[IDS.guild, 1_700_000_000_000]] });
  Object.assign(client, {
    testControlPolicy: policy,
    application: { id: IDS.app },
    destroy: async () => assert.fail('a matching test ready must not destroy the client'),
    testControlRuntimeController: { assertRunning() {}, markReady() { harness.calls.push({ label: 'ready.marked' }); } },
  });

  await client.listeners(Events.ClientReady)[0](client);
  assert.deepEqual(harness.calls.map((call) => call.label),
    ['polls.restore', 'reminders.restore', 'word-chain.reaction-outbox', 'number-chain.reaction-outbox', 'ready.marked']);
  for (const label of ['polls.restore', 'reminders.restore']) {
    assert.deepEqual(harness.calls.find((call) => call.label === label).context, readyContextFor(IDS.app), label);
  }
  for (const job of ['word-chain.reaction-outbox', 'number-chain.reaction-outbox']) {
    assertBackground(harness.calls.find((call) => call.label === job).context, job);
  }
  assert.deepEqual(harness.errors, []);
});

// Background jobs that services schedule themselves: each timer-driven run gets its own
// background context, whatever context created the timer.

test('every reminder firing runs as its own background job, not in the context that scheduled it', async (t) => {
  const { createReminderSystem } = require('../src/systems/schedule/reminders/reminderSystem');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-reminder-context-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'reminders.json');
  const channelId = '10000000000000040';
  const userId = '10000000000000041';
  const reminder = (message) => ({
    schemaVersion: 1, guildId: GUILD_A, channelId, sourceGuildId: GUILD_A, deliveryGuildId: GUILD_A,
    deliveryChannelId: channelId, userId, message, createdAt: 1, remindAt: 2, status: 'pending', attemptCount: 0,
  });
  fs.writeFileSync(filePath, JSON.stringify({ first: reminder('first'), second: reminder('second') }));
  const sendContexts = [];
  const channel = {
    guildId: GUILD_A, isTextBased: () => true, permissionsFor: () => ({ has: () => true }),
    async send() { sendContexts.push(getHostOperationContext()); },
  };
  const guild = { members: { me: { id: BOT_ID }, fetch: async () => ({ id: userId }) } };
  const client = { user: { id: BOT_ID }, guilds: { fetch: async () => guild }, channels: { fetch: async () => channel } };
  const system = createReminderSystem({ filePath });

  await runWithHostOperationContext(EVENT_CONTEXT_WITH_GRANT, () => system.restoreActiveReminders(client));
  await waitUntil(() => Object.values(system.readReminders()).every((record) => record.status === 'delivered'));
  assert.equal(sendContexts.length, 2);
  for (const context of sendContexts) assertBackground(context, 'reminder.deliver');
  assert.notEqual(sendContexts[0].sourceEventId, sendContexts[1].sourceEventId);
});

test('daily riddle and daily discussion ticks each run as their own background job', async () => {
  const riddle = require('../src/services/dailyRiddleService');
  const discussion = require('../src/services/dailyDiscussionService');
  for (const [start, stop, job] of [
    [riddle.startDailyRiddleScheduler, riddle.stopDailyRiddleScheduler, 'daily-riddle.tick'],
    [discussion.startDailyDiscussionScheduler, discussion.stopDailyDiscussionScheduler, 'daily-discussion.tick'],
  ]) {
    const contexts = [];
    const boundaries = [];
    const watchdogs = [];
    await runWithHostOperationContext(EVENT_CONTEXT_WITH_GRANT, () => start({}, {
      nowFn: () => new Date('2026-10-02T00:00:00.000Z'),
      tick: async () => { contexts.push(getHostOperationContext()); },
      setTimeoutFn: (callback) => { boundaries.push(callback); return { unref() {} }; },
      clearTimeoutFn: () => {},
      setIntervalFn: (callback) => { watchdogs.push(callback); return { unref() {} }; },
      clearIntervalFn: () => {},
    }));
    try {
      watchdogs[0]();
      await waitUntil(() => contexts.length === 2);
      boundaries[0]();
      await waitUntil(() => contexts.length === 3);
    } finally {
      stop();
    }
    // The first tick, a watchdog tick and a boundary tick.
    for (const context of contexts) assertBackground(context, job);
    assert.equal(new Set(contexts.map((context) => context.sourceEventId)).size, 3, job);
  }
});

test('every release announcement poll runs as its own background job', async () => {
  const {
    readReleaseAnnouncementConfig,
    startReleaseAnnouncementScheduler,
    stopReleaseAnnouncementScheduler,
  } = require('../src/services/releaseAnnouncementService');
  const contexts = [];
  const intervals = [];
  const state = runWithHostOperationContext(EVENT_CONTEXT_WITH_GRANT, () => startReleaseAnnouncementScheduler(
    { guilds: { cache: new Map() } }, {
      config: readReleaseAnnouncementConfig({ XIAOJI_RELEASE_DISPATCH_ENABLED: 'true' }),
      setIntervalFn: (callback) => { intervals.push(callback); return { unref() {} }; },
      clearIntervalFn: () => {},
      // No network: each poll records its context and fails before any request is made.
      fetchImpl: async () => {
        contexts.push(getHostOperationContext());
        throw new Error('synthetic offline');
      },
      healthReporter: async () => {},
    }));
  try {
    await state.inFlight;
    intervals[0]();
    await state.inFlight;
  } finally {
    await stopReleaseAnnouncementScheduler();
  }
  assert.equal(contexts.length, 2);
  for (const context of contexts) assertBackground(context, 'release-announcement.poll');
  assert.notEqual(contexts[0].sourceEventId, contexts[1].sourceEventId);
});

test('every scheduled status snapshot publish runs as its own background job', async () => {
  const { createStatusSnapshotPublisher } = require('../src/services/statusSnapshotPublisher');
  const contexts = [];
  const intervals = [];
  let uploads = 0;
  const publisher = createStatusSnapshotPublisher({}, {
    config: { endpoint: 'https://status.invalid/internal/status-snapshot', keyId: 'synthetic', secret: 's'.repeat(32) },
    snapshotBuilder: () => {
      contexts.push(getHostOperationContext());
      return { synthetic: true };
    },
    // No network: the upload is a local stub.
    fetchImpl: async () => {
      uploads += 1;
      return { ok: true };
    },
    loggerImpl: { warn() {} },
    setIntervalImpl: (callback) => { intervals.push(callback); return { unref() {} }; },
    clearIntervalImpl: () => {},
  });
  try {
    assert.deepEqual(runWithHostOperationContext(EVENT_CONTEXT_WITH_GRANT, () => publisher.start()), { started: true });
    await waitUntil(() => uploads === 1);
    await new Promise((resolve) => setImmediate(resolve));
    intervals[0]();
    await waitUntil(() => uploads === 2);
  } finally {
    publisher.stop();
  }
  assert.equal(contexts.length, 2);
  for (const context of contexts) assertBackground(context, 'status-snapshot.publish');
  assert.notEqual(contexts[0].sourceEventId, contexts[1].sourceEventId);
});

test('every conversation history cleanup runs as its own background job', async (t) => {
  const history = require('../src/services/conversationHistoryService');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-history-context-'));
  const historyPath = path.join(directory, 'aiConversationHistory.json');
  const previousPath = process.env.AI_CONVERSATION_PATH;
  process.env.AI_CONVERSATION_PATH = historyPath;
  t.after(async () => {
    await history.resetConversationHistoryForTests();
    if (previousPath === undefined) delete process.env.AI_CONVERSATION_PATH;
    else process.env.AI_CONVERSATION_PATH = previousPath;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await history.resetConversationHistoryForTests();
  // Each cleanup rewrites the history file; the rename into place shows the run's context.
  const contexts = [];
  const renameSync = fs.renameSync;
  t.mock.method(fs, 'renameSync', function renameSpy(from, to) {
    if (path.resolve(String(to)) === historyPath) contexts.push(getHostOperationContext());
    return renameSync.call(this, from, to);
  });
  const intervals = [];
  runWithHostOperationContext(EVENT_CONTEXT_WITH_GRANT, () => history.startConversationHistoryCleanupScheduler({
    setIntervalFn: (callback) => { intervals.push(callback); return { unref() {} }; },
    clearIntervalFn: () => {},
  }));
  await intervals[0]();
  await intervals[0]();
  assert.equal(contexts.length, 2);
  for (const context of contexts) assertBackground(context, 'conversation-history.cleanup');
  assert.notEqual(contexts[0].sourceEventId, contexts[1].sourceEventId);
});

test('board lifecycle timer ticks go through the injected runner, which the Discord runtime sets to a background job', async (t) => {
  const { createBoardLifecycle } = require('../src/systems/games/board/core/boardLifecycle');
  const intervals = [];
  t.mock.method(globalThis, 'setInterval', (callback) => {
    intervals.push(callback);
    return { unref() {} };
  });
  const store = { listRecoverable: async () => [], getSessionById: async () => null };
  const statusContexts = [];
  const service = {
    async status({ guildId, channelId, actorId }) {
      statusContexts.push(getHostOperationContext());
      return { session: { id: 'session-1', status: 'active', guildId, channelId, hostId: actorId } };
    },
    recoverSession: async () => null,
  };
  const session = { id: 'session-1', status: 'active', guildId: GUILD_A, channelId: '10000000000000050', hostId: BOT_ID };
  // Fires the newest lifecycle timer from an event context and waits until that tick ends.
  const fireTimer = async (expected) => {
    runWithHostOperationContext(EVENT_CONTEXT_WITH_GRANT, () => intervals.at(-1)());
    await waitUntil(() => statusContexts.length === expected);
    await new Promise((resolve) => setTimeout(resolve, 5));
  };

  const background = createBoardLifecycle({ store, service, intervalMs: 1_000, logger: { error() {} },
    runScheduledTick: (tick) => runWithBackgroundContext('board.lifecycle-tick', tick) });
  await background.start();
  background.track(session);
  await fireTimer(1);
  await fireTimer(2);
  await background.stop();
  for (const context of statusContexts) assertBackground(context, 'board.lifecycle-tick');
  assert.notEqual(statusContexts[0].sourceEventId, statusContexts[1].sourceEventId);

  // Without a runner the core keeps its old behaviour and adds no context of its own.
  const plain = createBoardLifecycle({ store, service, intervalMs: 1_000, logger: { error() {} } });
  await plain.start();
  plain.track(session);
  await fireTimer(3);
  await plain.stop();
  assert.deepEqual(statusContexts[2], EVENT_CONTEXT_WITH_GRANT);
  assert.throws(() => createBoardLifecycle({ store, service, runScheduledTick: 'not-a-function' }),
    (error) => error.code === 'INVALID_REQUEST');

  // The Discord board runtime hands the lifecycle a runner that starts a background job.
  let lifecycleOptions = null;
  stubModule(t, path.join(SRC, 'systems', 'games', 'board', 'core', 'boardLifecycle.js'), {
    createBoardLifecycle(options) {
      lifecycleOptions = options;
      return { start: async () => ({}), stop: async () => {}, tick: async () => {}, track() {},
        isStarted: () => false, trackedCount: () => 0 };
    },
  });
  const runtimePath = require.resolve(path.join(SRC, 'systems', 'games', 'board', 'discord', 'boardDiscordRuntime.js'));
  const previousRuntime = require.cache[runtimePath];
  delete require.cache[runtimePath];
  t.after(() => {
    if (previousRuntime) require.cache[runtimePath] = previousRuntime;
    else delete require.cache[runtimePath];
  });
  const { InMemoryBoardStore } = require('./support/inMemoryBoardStore');
  require(runtimePath).createBoardDiscordRuntime({
    client: {}, store: new InMemoryBoardStore(), runtimeLogger: { error() {}, warn() {}, info() {} },
    transport: { async update() {}, async messageExists() { return true; } },
  });
  assertBackground(lifecycleOptions.runScheduledTick(() => getHostOperationContext()), 'board.lifecycle-tick');
});
