'use strict';

// The catalog says which commands and subcommands need a server permission or the bot owner.
// These tests run the real permission checks of the real command modules against those marks.
//
// A refused call stops before any service, database or Discord request. The paths that are meant to
// get through are run against stubbed services: a call that passes the permission check lands in a
// stub that records it, so nothing here can reach the coin database or write data.

const assert = require('node:assert/strict');
const test = require('node:test');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const bankService = require('../src/services/bankService');
const coinService = require('../src/services/coinService');
const workService = require('../src/services/workService');
const { loadCommands } = require('../src/loadCommands');
const commandCatalog = require('../website/commandCatalog');

const { COMMAND_CATALOG, getSubcommandAudience } = commandCatalog;
const { CoinServiceError } = coinService;
// A board names people with mentions, but a leaderboard reply must not notify any of them.
const NO_PINGS = { parse: [] };
const GUILD_ID = '223456789012345678';
const CHANNEL_ID = '323456789012345678';
const OWNER_ID = 'synthetic-owner';
const MEMBER_ID = 'synthetic-member';
const ADMINISTRATOR_ID = 'synthetic-administrator';
const SERVER_PERMISSION_DENIAL = /^你需要 (?:Administrator|Manage Server) 權限才能使用 \/([a-z0-9-]+)。$/u;
const OWNER_DENIAL = /你沒有權限使用這個指令|只有小吉擁有者/u;
const ANY_DENIAL = /權限才能使用|你沒有權限|只有小吉擁有者/u;

// Below the commands, the services are replaced by stubs that record each call. They are installed
// before any command loads, because a command takes its service functions when it is first required.
// The functions are not async on purpose: the quota service is synchronous and the commands await
// the others, so a plain return value works for both.
const downstreamCalls = [];
const stubResults = new Map();
const defaultStubResults = {
  listJobs: () => ({
    jobs: [{ name: '測試職業', rank: '測試官階', salary: 100, reportChannelName: 'test', description: '測試用職業' }],
    minDays: 1,
    maxDays: 30,
    payTime: '每日 00:00',
  }),
  getBankRates: () => ({ demandRate: 0.0003, fixedRates: { 7: 0.01, 14: 0.02, 30: 0.03, 90: 0.05 }, activeEvents: [] }),
  listShopItems: (guildId, { page }) => ({ page, items: [] }),
  getAllPurchaseHistory: () => [],
  getGuildCoinSettings: () => ({ enabled: true }),
  getLeaderboard: (guildId, { page, limit }) => ({ page, limit, players: [{ userId: 'player-1', balance: 1200, dailyStreak: 3 }] }),
  getAllBalanceSummaries: () => [{ userId: 'player-1', totalAssets: 5000 }],
};

function installStub(service, name) {
  const original = service[name];
  service[name] = (...args) => {
    downstreamCalls.push({ name, args });
    return stubResults.get(name)(...args);
  };
  test.after(() => { service[name] = original; });
}

for (const [service, names] of [
  [workService, ['listJobs']],
  [bankService, ['getBankRates', 'getAllBalanceSummaries']],
  [coinService, ['getGuildCoinSettings', 'listShopItems', 'getAllPurchaseHistory', 'getLeaderboard']],
]) {
  for (const name of names) installStub(service, name);
}

// The Discord user ids the commands looked up (to leave bots out of a board), in order.
const fetchedUserIds = [];

function resetStubs() {
  downstreamCalls.length = 0;
  fetchedUserIds.length = 0;
  stubResults.clear();
  for (const [name, implementation] of Object.entries(defaultStubResults)) stubResults.set(name, implementation);
}

// Every path a user can type: a command without subcommands, or one command plus one subcommand.
const paths = COMMAND_CATALOG.flatMap((entry) => (entry.subcommands.length === 0
  ? [{ entry, subcommand: null, audience: entry.audience }]
  : entry.subcommands.map((subcommand) => ({ entry, subcommand, audience: getSubcommandAudience(entry, subcommand) }))));
const labelOf = ({ entry, subcommand }) => (subcommand ? `/${entry.name} ${subcommand}` : `/${entry.name}`);

// strings, integers and booleans are the option values a test gives; every other option is empty.
// botIds are the Discord users that turn out to be bots when a command looks them up.
function createInteraction({
  name, subcommand, userId, administrator = false, guildName = 'Synthetic Guild', strings = {}, integers = {}, booleans = {},
  botIds = [],
}) {
  const calls = [];
  const permissions = { has: (flag) => administrator && flag === PermissionFlagsBits.Administrator };
  const channel = {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    name: 'synthetic-channel',
    type: ChannelType.GuildText,
    isTextBased: () => true,
    isThread: () => false,
    send: async () => {},
    permissionsFor: () => ({ has: () => true }),
  };
  const botMember = { id: 'synthetic-bot', permissions: { has: () => true } };
  const [group, leaf] = subcommand && subcommand.includes(' ') ? subcommand.split(' ') : [null, subcommand];
  const interaction = {
    commandName: name,
    id: 'synthetic-interaction',
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    channel,
    user: { id: userId, tag: `${userId}#0001`, username: userId, bot: false },
    client: {
      users: {
        fetch: async (id) => {
          fetchedUserIds.push(id);
          return { id, bot: botIds.includes(id), toString: () => `<@${id}>` };
        },
      },
    },
    memberPermissions: permissions,
    replied: false,
    deferred: false,
    inGuild: () => true,
    guild: {
      id: GUILD_ID,
      name: guildName,
      memberCount: 2,
      members: { me: botMember, fetchMe: async () => botMember, fetch: async (id) => ({ id, permissions }) },
      channels: { cache: new Map(), fetch: async () => channel },
    },
    options: {
      getSubcommand: () => leaf,
      getSubcommandGroup: () => group,
      getChannel: () => channel,
      getString: (key) => strings[key] ?? null,
      getInteger: (key) => integers[key] ?? null,
      getNumber: () => null,
      getBoolean: (key) => booleans[key] ?? null,
      getUser: () => null,
      getRole: () => null,
      getAttachment: () => null,
    },
    async reply(payload) { calls.push({ method: 'reply', payload }); interaction.replied = true; },
    async followUp(payload) { calls.push({ method: 'followUp', payload }); },
    async deferReply(payload) { calls.push({ method: 'deferReply', payload }); interaction.deferred = true; },
    async editReply(payload) { calls.push({ method: 'editReply', payload }); },
  };
  return { interaction, calls };
}

function withOwner(t) {
  const previous = process.env.BOT_OWNER_ID;
  process.env.BOT_OWNER_ID = OWNER_ID;
  t.mock.method(console, 'warn', () => {});
  t.after(() => {
    if (previous === undefined) delete process.env.BOT_OWNER_ID;
    else process.env.BOT_OWNER_ID = previous;
  });
}

async function run(commands, target, user) {
  const { interaction, calls } = createInteraction({ name: target.entry.name, subcommand: target.subcommand, ...user });
  await commands.get(target.entry.name).execute(interaction);
  return calls;
}

function assertSingleEphemeralReply(calls, label) {
  assert.equal(calls.length, 1, `${label} must answer once and do nothing else: ${JSON.stringify(calls)}`);
  assert.equal(calls[0].method, 'reply', label);
  assert.equal(calls[0].payload.ephemeral, true, `${label} refusal must be private`);
  return calls[0].payload.content;
}

// What a command finally told the user: its one reply, or the edit that completed a deferred reply. A
// deferral only acknowledges the command, so it is not an answer.
function answerOf(calls, label) {
  const answers = calls.filter(({ method }) => method !== 'deferReply');
  assert.equal(answers.length, 1, `${label} answers once: ${JSON.stringify(calls)}`);
  return answers[0];
}

test('the catalog marks the paths this suite relies on', () => {
  const labels = (audience) => paths.filter((target) => target.audience === audience).map(labelOf);
  for (const required of ['/work status-user', '/bank balance-user', '/economy overview', '/shop purchases-user', '/set-welcome']) {
    assert.ok(labels('admin').includes(required), `${required} must be marked admin`);
  }
  for (const required of [
    '/work appeal-review', '/bank rate-set-demand', '/coin-admin add',
  ]) {
    assert.ok(labels('owner').includes(required), `${required} must be marked owner`);
  }
  for (const required of ['/work list', '/bank interest', '/shop list', '/leaderboard']) {
    assert.ok(labels('public').includes(required), `${required} must be marked public`);
  }
});

test('every admin command and subcommand refuses an ordinary member before doing any work', async (t) => {
  withOwner(t);
  resetStubs();
  const commands = loadCommands(undefined, { warn: null });
  const adminPaths = paths.filter((target) => target.audience === 'admin');
  assert.ok(adminPaths.length >= 30, `only ${adminPaths.length} admin paths found`);
  for (const target of adminPaths) {
    const label = labelOf(target);
    const calls = await run(commands, target, { userId: MEMBER_ID });
    const content = assertSingleEphemeralReply(calls, label);
    const denial = SERVER_PERMISSION_DENIAL.exec(content);
    assert.ok(denial, `${label} must refuse with the permission message, got: ${content}`);
    assert.equal(denial[1], target.entry.name, `${label} refusal must come from its own command`);
  }
  assert.deepEqual(downstreamCalls, [], 'no refused call reached a service');
});

test('an admin command is hidden from members behind the lowest permission its own checks ask for', async (t) => {
  withOwner(t);
  resetStubs();
  const commands = loadCommands(undefined, { warn: null });
  const adminCommands = COMMAND_CATALOG.filter((entry) => entry.audience === 'admin');
  assert.ok(adminCommands.length >= 8, `only ${adminCommands.length} admin commands found`);
  for (const entry of adminCommands) {
    // The permission each admin path asks for, read from the real check: it asks for the permission it names
    // first and for Administrator second, so a path that names only Administrator asks for it twice.
    const needed = new Set();
    for (const target of paths.filter((candidate) => candidate.entry === entry && candidate.audience === 'admin')) {
      const label = labelOf(target);
      const { interaction, calls } = createInteraction({ name: entry.name, subcommand: target.subcommand, userId: MEMBER_ID });
      const asked = [];
      interaction.memberPermissions = { has: (flag) => { asked.push(flag); return false; } };
      await commands.get(entry.name).execute(interaction);
      assert.match(assertSingleEphemeralReply(calls, label), SERVER_PERMISSION_DENIAL, label);
      needed.add(asked.find((flag) => flag !== PermissionFlagsBits.Administrator) ?? PermissionFlagsBits.Administrator);
    }
    // Administrator passes every check, so any other permission is the lower one. Paths that ask for two
    // different non-Administrator permissions have no lowest one; that is a decision for a person.
    const lower = [...needed].filter((flag) => flag !== PermissionFlagsBits.Administrator);
    assert.ok(lower.length <= 1, `/${entry.name} paths ask for different permissions: ${[...needed].join(', ')}`);
    const lowest = lower[0] ?? PermissionFlagsBits.Administrator;
    // Discord hides the command from members without this permission, so a lower value would show it to
    // people every path refuses and a higher one would hide it from people some path accepts.
    assert.equal(
      commands.get(entry.name).data.toJSON().default_member_permissions,
      String(lowest),
      `/${entry.name} default_member_permissions follows the lowest permission its checks ask for`,
    );
  }
  assert.deepEqual(downstreamCalls, [], 'no refused call reached a service');
});

test('the work, bank and economy admin subcommands each refuse an ordinary member', async (t) => {
  withOwner(t);
  resetStubs();
  const commands = loadCommands(undefined, { warn: null });
  const expected = {
    work: ['status-user', 'status-all', 'task-add', 'tasks-all', 'pending', 'review', 'admin-remind', 'role-sync', 'payroll-preview', 'payroll-history'],
    bank: ['balance-user', 'balance-all', 'fixed-user', 'fixed-all', 'rate-history'],
    economy: ['overview', 'user', 'audit'],
  };
  for (const [name, subcommands] of Object.entries(expected)) {
    const entry = commandCatalog.getCommand(name);
    assert.deepEqual(entry.subcommands.filter((subcommand) => getSubcommandAudience(entry, subcommand) === 'admin'), subcommands);
    for (const subcommand of subcommands) {
      const label = `/${name} ${subcommand}`;
      const calls = await run(commands, { entry, subcommand }, { userId: MEMBER_ID });
      assert.match(assertSingleEphemeralReply(calls, label), SERVER_PERMISSION_DENIAL, label);
    }
  }
});

test('every owner-only subcommand refuses an ordinary member and a server Administrator', async (t) => {
  withOwner(t);
  resetStubs();
  const commands = loadCommands(undefined, { warn: null });
  const ownerPaths = paths.filter((target) => target.audience === 'owner');
  assert.ok(ownerPaths.length >= 7, `only ${ownerPaths.length} owner paths found`);
  for (const target of ownerPaths) {
    const label = labelOf(target);
    for (const user of [{ userId: MEMBER_ID }, { userId: ADMINISTRATOR_ID, administrator: true }]) {
      const calls = await run(commands, target, user);
      const content = assertSingleEphemeralReply(calls, `${label} as ${user.userId}`);
      assert.match(content, OWNER_DENIAL, `${label} as ${user.userId} must refuse with the owner message`);
    }
  }
  assert.deepEqual(downstreamCalls, [], 'no refused call reached a service');
});

test('an owner-only subcommand inside a wider command does not widen that command', async (t) => {
  withOwner(t);
  resetStubs();
  const commands = loadCommands(undefined, { warn: null });
  for (const [name, subcommand] of [['work', 'appeal-review'], ['bank', 'rate-set-demand'], ['bank', 'rate-set-fixed']]) {
    const entry = commandCatalog.getCommand(name);
    assert.equal(entry.audience, 'public', `/${name} stays open to members`);
    assert.equal(getSubcommandAudience(entry, subcommand), 'owner');
    const calls = await run(commands, { entry, subcommand }, { userId: ADMINISTRATOR_ID, administrator: true });
    assert.match(assertSingleEphemeralReply(calls, `/${name} ${subcommand}`), OWNER_DENIAL);
  }
  const coinAdmin = commandCatalog.getCommand('coin-admin');
  assert.equal(coinAdmin.audience, 'admin');
  for (const subcommand of ['add', 'remove', 'set', 'reset-user']) {
    assert.equal(getSubcommandAudience(coinAdmin, subcommand), 'owner', `/coin-admin ${subcommand}`);
  }
  for (const subcommand of ['history', 'enable', 'disable']) {
    assert.equal(getSubcommandAudience(coinAdmin, subcommand), 'admin', `/coin-admin ${subcommand}`);
  }
});

test('ordinary members get past the permission check on the public paths of work, bank, shop and leaderboard', async (t) => {
  withOwner(t);
  resetStubs();
  const commands = loadCommands(undefined, { warn: null });
  const samples = [
    // The job list is the same everywhere, so listJobs takes no guild.
    { name: 'work', subcommand: 'list', services: ['listJobs'], takesGuild: false, reply: /小吉職業清單/u, ephemeral: true },
    { name: 'bank', subcommand: 'interest', services: ['getBankRates'], reply: /目前銀行利率/u, ephemeral: true },
    { name: 'shop', subcommand: 'list', services: ['listShopItems'], reply: /目前商店沒有可購買的商品/u, ephemeral: true },
    { name: 'leaderboard', subcommand: null, services: ['getLeaderboard'], reply: /吉幣排行榜/u, ephemeral: undefined },
    // The assets board checks that the guild's coin system is on before it reads any rows. It then
    // acknowledges the command before it looks up as many as 25 users, and edits that reply with the board.
    {
      name: 'leaderboard',
      subcommand: null,
      strings: { type: 'assets' },
      services: ['getGuildCoinSettings', 'getAllBalanceSummaries'],
      methods: ['deferReply', 'editReply'],
      reply: /總資產排行榜/u,
      ephemeral: undefined,
    },
  ];
  for (const sample of samples) {
    downstreamCalls.length = 0;
    const entry = commandCatalog.getCommand(sample.name);
    const target = { entry, subcommand: sample.subcommand };
    const label = labelOf(target);
    const audience = sample.subcommand ? getSubcommandAudience(entry, sample.subcommand) : entry.audience;
    assert.equal(audience, 'public', `${label} is marked public`);

    const calls = await run(commands, target, { userId: MEMBER_ID, strings: sample.strings });
    assert.deepEqual(downstreamCalls.map(({ name }) => name), sample.services, `${label} must reach ${sample.services.join(', ')}`);
    if (sample.takesGuild !== false) assert.equal(downstreamCalls[0].args[0], GUILD_ID, `${label} asks for the current guild`);
    assert.deepEqual(calls.map(({ method }) => method), sample.methods ?? ['reply'], `${label} answers once: ${JSON.stringify(calls)}`);
    const answer = answerOf(calls, label);
    assert.match(answer.payload.content, sample.reply, label);
    assert.doesNotMatch(answer.payload.content, ANY_DENIAL, `${label} must not be refused`);
    assert.equal(answer.payload.ephemeral, sample.ephemeral, `${label} visibility`);
  }
});

test('a refused member never reaches the service, while a server Administrator does', async (t) => {
  withOwner(t);
  resetStubs();
  const commands = loadCommands(undefined, { warn: null });
  const entry = commandCatalog.getCommand('shop');
  const target = { entry, subcommand: 'purchases-all' };
  assert.equal(getSubcommandAudience(entry, 'purchases-all'), 'admin');

  const refused = await run(commands, target, { userId: MEMBER_ID });
  assert.match(assertSingleEphemeralReply(refused, '/shop purchases-all'), SERVER_PERMISSION_DENIAL);
  assert.deepEqual(downstreamCalls, [], 'a refused call stops before the service');

  const allowed = await run(commands, target, { userId: ADMINISTRATOR_ID, administrator: true });
  assert.deepEqual(downstreamCalls.map(({ name }) => name), ['getAllPurchaseHistory'], 'the stub sees an allowed call');
  assert.equal(assertSingleEphemeralReply(allowed, '/shop purchases-all as Administrator'), '目前沒有購買紀錄。');
});

test('the merged leaderboard keeps the visibility of the two boards it replaced', async (t) => {
  withOwner(t);
  resetStubs();
  const commands = loadCommands(undefined, { warn: null });
  const target = { entry: commandCatalog.getCommand('leaderboard'), subcommand: null };
  let lastCalls = [];
  const board = async (values = {}) => {
    downstreamCalls.length = 0;
    lastCalls = await run(commands, target, { userId: MEMBER_ID, ...values });
    return answerOf(lastCalls, '/leaderboard').payload;
  };

  // Coin balances (the old /leaderboard): public with data, private notice without, ten to a page.
  const coins = await board();
  assert.deepEqual(lastCalls.map(({ method }) => method), ['reply'], 'the coin board is one plain reply');
  assert.equal(coins.ephemeral, undefined);
  assert.equal(coins.content, '**Synthetic Guild 吉幣排行榜**\n1. <@player-1> - 1,200 吉幣（連續 3 天）');
  assert.deepEqual(downstreamCalls, [{ name: 'getLeaderboard', args: [GUILD_ID, { page: 1, limit: 10 }] }]);
  await board({ strings: { type: 'coins' }, integers: { page: 2 } });
  assert.deepEqual(downstreamCalls, [{ name: 'getLeaderboard', args: [GUILD_ID, { page: 2, limit: 10 }] }]);
  stubResults.set('getLeaderboard', () => ({ page: 1, limit: 10, players: [] }));
  assert.deepEqual(await board(), { content: '目前還沒有吉幣排行榜資料。', ephemeral: true, allowedMentions: NO_PINGS });

  // Total assets (the old /economy leaderboard): public with or without data, always the top 25.
  const assets = await board({ strings: { type: 'assets' } });
  assert.deepEqual(assets, { content: '**Synthetic Guild 總資產排行榜**\n1. <@player-1> - 5,000 吉幣', allowedMentions: NO_PINGS });
  // It acknowledges the command first and edits that reply, so its visibility is the public deferral's.
  assert.deepEqual(lastCalls.map(({ method }) => method), ['deferReply', 'editReply']);
  assert.ok(!lastCalls[0].payload?.ephemeral, 'the acknowledgement is public');
  assert.deepEqual(downstreamCalls, [
    { name: 'getGuildCoinSettings', args: [GUILD_ID] },
    { name: 'getAllBalanceSummaries', args: [GUILD_ID, { limit: 25 }] },
  ]);
  await board({ strings: { type: 'assets' }, integers: { page: 3 } });
  assert.deepEqual(downstreamCalls.at(-1), { name: 'getAllBalanceSummaries', args: [GUILD_ID, { limit: 25 }] }, 'assets ignores page');
  stubResults.set('getAllBalanceSummaries', () => []);
  assert.deepEqual(await board({ strings: { type: 'assets' } }), { content: '目前沒有經濟資料。', allowedMentions: NO_PINGS });

  // 25 long lines still fit in one Discord message (2000 characters), even with the longest names.
  stubResults.set('getAllBalanceSummaries', () => Array.from({ length: 25 }, (_, index) => ({
    userId: `${'1'.repeat(19)}${index % 10}`,
    totalAssets: Number.MAX_SAFE_INTEGER,
  })));
  const longest = await board({ strings: { type: 'assets' }, guildName: 'x'.repeat(100) });
  assert.equal(longest.content.split('\n').length, 26);
  assert.ok(longest.content.length <= 2000, `the assets board has ${longest.content.length} characters`);
});

// Players ranked 1..count; the user id carries the rank so a line shows whether its label is right.
function rankedPlayers(count) {
  return Array.from({ length: count }, (_, index) => ({ userId: `player-${index + 1}`, balance: 9000 - index * 10, dailyStreak: 1 }));
}

// A stand-in for the service's paging: the rows at the requested offset, and the page and size it used.
function pagedLeaderboard(players) {
  return (guildId, { page, limit }) => ({ page, limit, players: players.slice((page - 1) * limit, page * limit) });
}

const rankOf = (line) => Number(/^(\d+)\. /u.exec(line)[1]);
const boardLines = (payload) => payload.content.split('\n').slice(1);

test('a guild that turned its coin system off gets no board of either kind', async (t) => {
  withOwner(t);
  resetStubs();
  const commands = loadCommands(undefined, { warn: null });
  const target = { entry: commandCatalog.getCommand('leaderboard'), subcommand: null };
  const disabled = { content: '這個伺服器的吉幣系統目前停用。', ephemeral: true };
  stubResults.set('getGuildCoinSettings', () => ({ enabled: false }));
  stubResults.set('getLeaderboard', () => {
    throw new CoinServiceError('COIN_DISABLED', disabled.content);
  });

  for (const strings of [{}, { type: 'coins' }, { type: 'assets' }]) {
    downstreamCalls.length = 0;
    fetchedUserIds.length = 0;
    const calls = await run(commands, target, { userId: MEMBER_ID, strings });
    assert.equal(calls.length, 1, `type ${strings.type ?? '(none)'} answers once`);
    assert.deepEqual(calls[0].payload, disabled, `type ${strings.type ?? '(none)'} is refused privately`);
    assert.deepEqual(fetchedUserIds, [], 'no user was looked up for a board that is not shown');
    assert.equal(downstreamCalls.some(({ name }) => name === 'getAllBalanceSummaries'), false, 'the assets rows are never read');
  }

  // The same guild with the coin system on shows the assets board again.
  stubResults.set('getGuildCoinSettings', () => ({ enabled: true }));
  const calls = await run(commands, target, { userId: MEMBER_ID, strings: { type: 'assets' } });
  assert.match(answerOf(calls, '/leaderboard type:assets').payload.content, /總資產排行榜/u);
});

test('bots are left out of both boards and the ranks keep each row\'s real place', async (t) => {
  withOwner(t);
  resetStubs();
  const commands = loadCommands(undefined, { warn: null });
  const target = { entry: commandCatalog.getCommand('leaderboard'), subcommand: null };
  const players = rankedPlayers(5);
  stubResults.set('getLeaderboard', pagedLeaderboard(players));
  stubResults.set('getAllBalanceSummaries', () => players.map(({ userId, balance }) => ({ userId, totalAssets: balance })));
  const botIds = ['player-2', 'player-5'];

  for (const strings of [{ type: 'coins' }, { type: 'assets' }]) {
    fetchedUserIds.length = 0;
    const calls = await run(commands, target, { userId: MEMBER_ID, strings, botIds });
    const answer = answerOf(calls, `${strings.type} board`).payload;
    const lines = boardLines(answer);
    assert.deepEqual(lines.map(rankOf), [1, 3, 4], `${strings.type} shows the people only, with a gap where a bot was`);
    for (const line of lines) assert.ok(line.startsWith(`${rankOf(line)}. <@player-${rankOf(line)}> - `), `${strings.type}: ${line}`);
    assert.equal(answer.content.includes('player-2'), false);
    assert.equal(answer.content.includes('player-5'), false);
    assert.deepEqual([...fetchedUserIds].sort(), players.map(({ userId }) => userId).sort(), `${strings.type} looks every row up`);
  }

  // A board of nothing but bots is the empty board.
  const onlyBots = await run(commands, target, { userId: MEMBER_ID, strings: { type: 'assets' }, botIds: players.map(({ userId }) => userId) });
  assert.deepEqual(answerOf(onlyBots, 'the board of only bots').payload, { content: '目前沒有經濟資料。', allowedMentions: NO_PINGS });
});

test('no leaderboard reply can ping anyone', async (t) => {
  withOwner(t);
  resetStubs();
  const commands = loadCommands(undefined, { warn: null });
  const target = { entry: commandCatalog.getCommand('leaderboard'), subcommand: null };
  const board = async (strings) => answerOf(await run(commands, target, { userId: MEMBER_ID, strings }), '/leaderboard').payload;

  const coinsWithData = await board({});
  stubResults.set('getLeaderboard', () => ({ page: 1, limit: 10, players: [] }));
  const coinsEmpty = await board({});
  const assetsWithData = await board({ type: 'assets' });
  stubResults.set('getAllBalanceSummaries', () => []);
  const assetsEmpty = await board({ type: 'assets' });

  for (const reply of [coinsWithData, coinsEmpty, assetsWithData, assetsEmpty]) {
    assert.deepEqual(reply.allowedMentions, NO_PINGS, reply.content);
  }
  // The boards still name people as mentions; they just cannot notify them.
  assert.ok(coinsWithData.content.includes('<@player-1>'));
  assert.ok(assetsWithData.content.includes('<@player-1>'));
});

test('the coin board pages ten rows at a time and ranks follow where each row really is', async (t) => {
  withOwner(t);
  resetStubs();
  const commands = loadCommands(undefined, { warn: null });
  const target = { entry: commandCatalog.getCommand('leaderboard'), subcommand: null };
  const players = rankedPlayers(25);
  stubResults.set('getLeaderboard', pagedLeaderboard(players));
  const botIds = ['player-3', 'player-12'];
  const pageOf = async (page) => {
    downstreamCalls.length = 0;
    const calls = await run(commands, target, { userId: MEMBER_ID, integers: { page }, botIds });
    assert.deepEqual(downstreamCalls, [{ name: 'getLeaderboard', args: [GUILD_ID, { page, limit: 10 }] }], `page ${page} asks for ten rows`);
    return calls[0].payload;
  };

  const shown = [];
  for (const [page, expected] of [
    [1, [1, 2, 4, 5, 6, 7, 8, 9, 10]],
    [2, [11, 13, 14, 15, 16, 17, 18, 19, 20]],
    [3, [21, 22, 23, 24, 25]],
  ]) {
    const lines = boardLines(await pageOf(page));
    assert.deepEqual(lines.map(rankOf), expected, `page ${page}`);
    for (const line of lines) {
      const rank = rankOf(line);
      assert.ok(line.startsWith(`${rank}. <@player-${rank}> - ${players[rank - 1].balance.toLocaleString('zh-TW')} 吉幣`), `page ${page}: ${line}`);
    }
    shown.push(...lines.map(rankOf));
  }
  // Page 2 starts at rank 11 with the 11th player (it used to show the 26th under the label 11),
  // and across the pages every person appears once, in order, with no row skipped.
  assert.deepEqual(shown, Array.from({ length: 25 }, (_, index) => index + 1).filter((rank) => ![3, 12].includes(rank)));
  assert.equal(boardLines(await pageOf(2))[0].startsWith('11. <@player-11> '), true);

  const beyond = await pageOf(4);
  assert.deepEqual(beyond, { content: '目前還沒有吉幣排行榜資料。', ephemeral: true, allowedMentions: NO_PINGS });
});

test('ranks come from the page and size the service reports, not from what was asked', async (t) => {
  withOwner(t);
  resetStubs();
  const commands = loadCommands(undefined, { warn: null });
  const target = { entry: commandCatalog.getCommand('leaderboard'), subcommand: null };
  // A service that capped the page size at 4 would put page 3 at offset 8.
  stubResults.set('getLeaderboard', (guildId, { page }) => ({ page, limit: 4, players: rankedPlayers(30).slice((page - 1) * 4, page * 4) }));
  const calls = await run(commands, target, { userId: MEMBER_ID, integers: { page: 3 } });
  assert.deepEqual(boardLines(calls[0].payload).map(rankOf), [9, 10, 11, 12]);
});

test('an old client that still sends /economy leaderboard gets a private pointer, and members are still refused', async (t) => {
  withOwner(t);
  resetStubs();
  const commands = loadCommands(undefined, { warn: null });
  const entry = commandCatalog.getCommand('economy');
  assert.equal(entry.subcommands.includes('leaderboard'), false, 'the subcommand is gone from the catalog');
  const stale = { entry, subcommand: 'leaderboard' };

  for (const user of [{ userId: ADMINISTRATOR_ID, administrator: true }, { userId: OWNER_ID }]) {
    const calls = await run(commands, stale, user);
    const content = assertSingleEphemeralReply(calls, `/economy leaderboard as ${user.userId}`);
    assert.ok(content.includes('/leaderboard type:assets'), content);
    assert.doesNotMatch(content, ANY_DENIAL);
  }

  // The permission check still comes first: a member gets the usual refusal, not the pointer.
  const refused = await run(commands, stale, { userId: MEMBER_ID });
  assert.match(assertSingleEphemeralReply(refused, '/economy leaderboard as a member'), SERVER_PERMISSION_DENIAL);

  // Any other subcommand the command does not know is answered too instead of left hanging.
  const unknown = await run(commands, { entry, subcommand: 'bogus' }, { userId: ADMINISTRATOR_ID, administrator: true });
  const unknownContent = assertSingleEphemeralReply(unknown, '/economy bogus');
  assert.equal(unknownContent.includes('/leaderboard type:assets'), false);
  assert.match(unknownContent, /找不到這個子指令/u);
  assert.deepEqual(downstreamCalls, [], 'none of these reached a service');
});
