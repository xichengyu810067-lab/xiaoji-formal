'use strict';

// Where the owner-only commands go. A whole command whose catalog audience is "owner" is never one of the global
// commands. It is deployed only to the owner guild (XIAOJI_OWNER_GUILD_ID). Without a usable guild ID it is deployed
// nowhere, and it never falls back to the global scope.
//
// The public core ships no such command any more: the owner-only management commands are private commands, and what
// is tested for them (their own directory, the guild guard, the 0 permission, the deployment next to the other private
// commands) is in the private test suite. The deployment code that places a catalog's owner commands stays generic
// and these tests keep holding it, with a catalog in which three public builders are marked owner-only (and out of
// help), so no private command name is needed here. A real deployment of the public core has no owner command: the
// last tests here say so.
//
// Every Discord call goes to an in-memory fake, and the one test that starts src/index.js blocks the network first,
// so no test here opens a connection. Every call pins protectedGuildIds, ownerGuildId and the extension host, so a
// developer's own environment cannot change what these tests check.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  OWNER_GUILD_ENV,
  assertCleanupTarget,
  auditCommandRegistrations,
  buildDeploymentPlan,
  buildTestDeploymentPlan,
  cleanupCommandRegistrations,
  deployCommands,
  parseOwnerGuildId,
  runDeploymentCli,
  splitPublicCommands,
} = require('../deploy-commands');
const { createExtensionHost } = require('../src/extensions/extensionHost');
const { loadCommandData } = require('../src/loadCommands');
const { loadTestControlPolicy } = require('../src/platform/testControlPolicy');
const commandCatalog = require('../website/commandCatalog');
const { IDS, createFixture } = require('./testControlSupport');

const APP = '123456789012345678';
const OWNER_GUILD = '223456789012345678';
const OTHER_GUILD = '323456789012345678';
const TOKEN = 'synthetic-owner-guild-token-0123456789';
// Built at run time so this file never contains a token-shaped literal.
const TOKEN_SHAPED = ['M'.padEnd(24, 'x'), 'y'.repeat(6), 'z'.repeat(27)].join('.');
const PROJECT_ROOT = path.join(__dirname, '..');

const PUBLIC = loadCommandData(undefined, { scope: 'public' });
const clone = (value) => JSON.parse(JSON.stringify(value));
// Three public builders that the catalog below treats as owner-only commands (the real catalog has none).
const OWNER_NAMES = ['fortune', 'ping', 'roll'];
const GLOBAL_NAMES = PUBLIC.map((command) => command.name).filter((name) => !OWNER_NAMES.includes(name)).sort();
const OWNER_CATALOG = (() => {
  const draft = clone({
    COMMAND_ALIASES: commandCatalog.COMMAND_ALIASES,
    COMMAND_AUDIENCES: commandCatalog.COMMAND_AUDIENCES,
    COMMAND_CATALOG: commandCatalog.COMMAND_CATALOG,
    COMMAND_GROUPS: commandCatalog.COMMAND_GROUPS,
    REMOVED_COMMANDS: commandCatalog.REMOVED_COMMANDS,
  });
  for (const entry of draft.COMMAND_CATALOG.filter((candidate) => OWNER_NAMES.includes(candidate.name))) {
    entry.audience = 'owner';
    entry.listInHelp = false;
  }
  return draft;
})();
const names = (commands) => commands.map((command) => command.name).sort();
const sortedNames = (...lists) => lists.flat().sort();
const commandsRoute = () => `/applications/${APP}/commands`;
const guildRoute = (guildId) => `/applications/${APP}/guilds/${guildId}/commands`;
const httpError = (status) => Object.assign(new Error(`synthetic HTTP ${status}`), { status });

let lastId = 900000000000000000n;
function nextId() {
  lastId += 1n;
  return String(lastId);
}

// A command as Discord holds it: the builder JSON plus the fields Discord adds. The audit compares normalized JSON,
// so an identical copy counts as "registered as planned".
function registered(command, { guildId = null, id = nextId() } = {}) {
  return { ...clone(command), id, application_id: APP, version: nextId(), ...(guildId ? { guild_id: guildId } : {}) };
}

const THROWING_REST = Object.freeze({
  async get() { throw new Error('a dry run must not read from Discord'); },
  async put() { throw new Error('a dry run must not write to Discord'); },
  async delete() { throw new Error('a dry run must not delete from Discord'); },
});

// failures: { route: status } makes a read of that route fail with that HTTP status, as Discord does for a wrong
// guild ID (404) or a guild the bot is not in (403).
function createFakeDiscord({ global = [], guilds = {}, joinedGuildIds = [], identity = null, failures = {} } = {}) {
  const state = new Map([['global', global.map(clone)]]);
  for (const [guildId, commands] of Object.entries(guilds)) state.set(guildId, commands.map(clone));
  const listOf = (key) => {
    if (!state.has(key)) state.set(key, []);
    return state.get(key);
  };
  const calls = [];
  const guildCommands = new RegExp(`^/applications/${APP}/guilds/(\\d+)/commands$`);
  const guildCommand = new RegExp(`^/applications/${APP}/guilds/(\\d+)/commands/(\\d+)$`);
  const globalCommand = new RegExp(`^/applications/${APP}/commands/(\\d+)$`);
  const keyOf = (route) => {
    if (route === commandsRoute()) return 'global';
    const match = route.match(guildCommands);
    return match ? match[1] : null;
  };
  const rest = {
    async get(route) {
      calls.push({ method: 'GET', route });
      if (Object.hasOwn(failures, route)) throw httpError(failures[route]);
      const key = keyOf(route);
      if (key !== null) return clone(listOf(key));
      if (route === '/users/@me/guilds') return joinedGuildIds.map((id) => ({ id, name: 'synthetic guild' }));
      if (identity) {
        if (route === '/oauth2/applications/@me') return { id: identity.applicationId };
        if (route === '/users/%40me') return { id: identity.botUserId };
        if (route.startsWith('/guilds/')) return { id: route.slice('/guilds/'.length) };
        if (route.startsWith('/channels/')) return { id: route.slice('/channels/'.length), guild_id: identity.channelGuildId };
      }
      throw httpError(404);
    },
    async put(route, { body }) {
      calls.push({ method: 'PUT', route, body: clone(body) });
      const key = keyOf(route);
      if (key === null) throw httpError(404);
      state.set(key, body.map((command) => registered(command, { guildId: key === 'global' ? null : key })));
      return clone(state.get(key));
    },
    async delete(route) {
      calls.push({ method: 'DELETE', route });
      const globalMatch = route.match(globalCommand);
      const guildMatch = route.match(guildCommand);
      if (!globalMatch && !guildMatch) throw httpError(404);
      const list = listOf(globalMatch ? 'global' : guildMatch[1]);
      const index = list.findIndex((command) => command.id === (globalMatch ? globalMatch[1] : guildMatch[2]));
      if (index < 0) throw httpError(404);
      list.splice(index, 1);
    },
  };
  return {
    rest,
    calls,
    state,
    commandsIn: (key) => clone(listOf(key)),
    mutations: () => calls.filter((call) => call.method !== 'GET'),
  };
}

// An extension with one private command, declared for one guild, and optionally a legacy cleanup guild list.
function createPrivateHost(t, { guildId, commandName = 'synthetic-tool', cleanupGuildIds = [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-owner-guild-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'commands');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'synthetic-private.js'), [
    `const { SlashCommandBuilder } = require(${JSON.stringify(require.resolve('discord.js'))});`,
    'module.exports = {',
    `  data: new SlashCommandBuilder().setName(${JSON.stringify(commandName)}).setDescription('synthetic private command'),`,
    '  async execute() {},',
    '};',
  ].join('\n'));
  return createExtensionHost([{
    id: 'synthetic-private',
    commandDirectories: [{ path: directory, guildIds: [guildId] }],
    deployment: { cleanupGuildIds },
  }]);
}

// The options every call shares. extra overrides any of them.
function options(rest, extra = {}) {
  return {
    token: TOKEN,
    clientId: APP,
    rest,
    extensionHost: createExtensionHost([]),
    testControlPolicy: null,
    protectedGuildIds: null,
    ownerGuildId: null,
    commandCatalog: OWNER_CATALOG,
    report: () => {},
    ...extra,
  };
}

async function dryRun(extra = {}) {
  const lines = [];
  const result = await deployCommands(options(THROWING_REST, { dryRun: true, report: (line) => lines.push(line), ...extra }));
  return { result, lines };
}

const opsOf = (plan) => plan.map((operation) => [operation.kind, operation.guildId ?? null]);
const globalOf = (plan) => plan.find((operation) => operation.kind === 'public-global');
const ownerSet = new Set(OWNER_NAMES);

test('the catalog decides which commands are owner-only, and the split keeps every command exactly once', () => {
  const { globalCommands, ownerCommands } = splitPublicCommands(PUBLIC, OWNER_CATALOG);
  assert.deepEqual(names(ownerCommands), OWNER_NAMES);
  assert.deepEqual(names(globalCommands), GLOBAL_NAMES);
  assert.equal(globalCommands.length + ownerCommands.length, PUBLIC.length);
  // The default catalog is used when none is given: the public core's own has no owner-only command, so every
  // command is global. A catalog that marks another command owner-only moves it.
  assert.deepEqual(names(splitPublicCommands(PUBLIC).ownerCommands), []);
  assert.deepEqual(names(splitPublicCommands(PUBLIC).globalCommands), names(PUBLIC));
  assert.deepEqual(commandCatalog.COMMAND_CATALOG.filter((entry) => entry.audience === 'owner'), []);
  const stricter = clone({ COMMAND_CATALOG: OWNER_CATALOG.COMMAND_CATALOG });
  stricter.COMMAND_CATALOG.find((entry) => entry.name === 'weather').audience = 'owner';
  assert.deepEqual(names(splitPublicCommands(PUBLIC, stricter).ownerCommands), sortedNames(OWNER_NAMES, ['weather']));
});

test('XIAOJI_OWNER_GUILD_ID is one Discord guild ID: blank is unset and everything else is invalid', () => {
  for (const unset of [undefined, null, '', '   ', '\t']) assert.deepEqual({ ...parseOwnerGuildId(unset) }, { state: 'unset', guildId: null }, String(unset));
  assert.deepEqual({ ...parseOwnerGuildId(OWNER_GUILD) }, { state: 'valid', guildId: OWNER_GUILD });
  assert.deepEqual({ ...parseOwnerGuildId(`  ${OWNER_GUILD}\n`) }, { state: 'valid', guildId: OWNER_GUILD });
  assert.equal(parseOwnerGuildId('1'.repeat(16)).state, 'valid');
  assert.equal(parseOwnerGuildId('1'.repeat(22)).state, 'valid');
  for (const invalid of [
    'abc', '12345', '1'.repeat(15), '1'.repeat(23), `${OWNER_GUILD}x`, `x${OWNER_GUILD}`, `${OWNER_GUILD},${OTHER_GUILD}`,
    `${OWNER_GUILD} ${OTHER_GUILD}`, '<#1234567890123456>', `-${OWNER_GUILD}`, `${OWNER_GUILD}.0`, TOKEN_SHAPED, 223456789012345678, true, {}, [],
  ]) {
    assert.deepEqual({ ...parseOwnerGuildId(invalid) }, { state: 'invalid', guildId: null }, String(invalid));
  }
  assert.equal(OWNER_GUILD_ENV, 'XIAOJI_OWNER_GUILD_ID');
});

test('the plan under every owner guild setting never puts an owner command in the global body', async (t) => {
  const privateOnOwnerGuild = createPrivateHost(t, { guildId: OWNER_GUILD });
  const privateElsewhere = createPrivateHost(t, { guildId: OTHER_GUILD });
  const cases = [
    // [label, options, expected owner status, expected plan operations, expected guild body names by guild ID]
    ['unset', { ownerGuildId: null }, 'unset', [['public-global', null]], {}],
    ['blank', { ownerGuildId: '' }, 'unset', [['public-global', null]], {}],
    ['spaces only', { ownerGuildId: '   ' }, 'unset', [['public-global', null]], {}],
    ['not a number', { ownerGuildId: 'abc' }, 'invalid', [['public-global', null]], {}],
    ['too short', { ownerGuildId: '12345' }, 'invalid', [['public-global', null]], {}],
    ['a list of two guilds', { ownerGuildId: `${OWNER_GUILD},${OTHER_GUILD}` }, 'invalid', [['public-global', null]], {}],
    ['a token pasted by mistake', { ownerGuildId: TOKEN_SHAPED }, 'invalid', [['public-global', null]], {}],
    ['not a string', { ownerGuildId: 223456789012345678 }, 'invalid', [['public-global', null]], {}],
    ['valid and alone', { ownerGuildId: OWNER_GUILD }, 'guild', [['public-global', null], ['owner-guild', OWNER_GUILD]], {
      [OWNER_GUILD]: OWNER_NAMES,
    }],
    ['valid with surrounding spaces', { ownerGuildId: ` ${OWNER_GUILD} ` }, 'guild', [['public-global', null], ['owner-guild', OWNER_GUILD]], {
      [OWNER_GUILD]: OWNER_NAMES,
    }],
    ['valid and also the private guild', { ownerGuildId: OWNER_GUILD, extensionHost: privateOnOwnerGuild }, 'guild', [
      ['public-global', null], ['private-guild', OWNER_GUILD],
    ], { [OWNER_GUILD]: sortedNames(OWNER_NAMES, ['synthetic-tool']) }],
    ['valid and the private guild is another one', { ownerGuildId: OWNER_GUILD, extensionHost: privateElsewhere }, 'guild', [
      ['public-global', null], ['private-guild', OTHER_GUILD], ['owner-guild', OWNER_GUILD],
    ], { [OTHER_GUILD]: ['synthetic-tool'], [OWNER_GUILD]: OWNER_NAMES }],
    ['valid with --public-only', { ownerGuildId: OWNER_GUILD, publicOnly: true }, 'public-only', [['public-global', null]], {}],
  ];
  for (const [label, extra, status, operations, guildBodies] of cases) {
    const { result, lines } = await dryRun(extra);
    assert.deepEqual(opsOf(result.plan), operations, label);
    assert.equal(result.ownerDeployment.status, status, label);
    // Whatever the setting, the global body has no owner-only command, and every other public command is in it.
    assert.deepEqual(names(globalOf(result.plan).body), GLOBAL_NAMES, `${label}: global body`);
    assert.equal(result.globalCount, GLOBAL_NAMES.length, label);
    for (const operation of result.plan.filter((item) => item.guildId)) {
      assert.deepEqual(names(operation.body), guildBodies[operation.guildId], `${label}: body of guild ${operation.guildId}`);
    }
    // Where the owner commands go: one guild with the right ID, or nowhere.
    const placed = result.plan.filter((item) => item.body.some((command) => ownerSet.has(command.name)));
    assert.deepEqual(placed.map((item) => item.guildId ?? null), status === 'guild' ? [OWNER_GUILD] : [], label);
    assert.equal(result.ownerDeployment.commandCount, status === 'guild' ? OWNER_NAMES.length : 0, label);
    assert.equal(result.ownerDeployment.guildId, status === 'guild' ? OWNER_GUILD : null, label);
    // One line when the commands are not sent: a warning for a missing or bad ID, a note for --public-only. When they are
    // sent, only a guild that no private group declares has one: a dry run cannot make the check a real run makes first.
    const owner = lines.filter((line) => line.startsWith('[OWNER_COMMANDS]'));
    const readsFirst = result.plan.some((item) => item.kind === 'owner-guild');
    assert.equal(owner.length, status === 'guild' ? Number(readsFirst) : 1, `${label}: ${owner.join(' | ')}`);
    if (readsFirst) assert.match(owner[0], /^\[OWNER_COMMANDS\] notice: a real deployment first reads the commands Discord holds in the owner guild/u, label);
    if (status === 'unset' || status === 'invalid') {
      assert.match(owner[0], /^\[OWNER_COMMANDS\] warning: XIAOJI_OWNER_GUILD_ID is not /u, label);
      assert.ok(owner[0].includes('never deployed globally'), label);
      assert.ok(OWNER_NAMES.every((name) => owner[0].includes(`/${name}`)), label);
    }
    if (status === 'public-only') assert.match(owner[0], /^\[OWNER_COMMANDS\] notice: --public-only never touches guild routes/u);
    // A value that was set is never echoed back, whether it is a bad guild ID or a pasted token.
    for (const secret of [extra.ownerGuildId, TOKEN, TOKEN_SHAPED].filter((value) => typeof value === 'string' && value.trim() !== '')) {
      assert.ok(lines.every((line) => !line.includes(secret.trim())), `${label}: ${secret}`);
    }
  }
});

test('a real deployment sends the owner commands only to the owner guild', async () => {
  const fake = createFakeDiscord();
  const lines = [];
  const result = await deployCommands(options(fake.rest, { ownerGuildId: OWNER_GUILD, report: (line) => lines.push(line) }));

  assert.deepEqual(fake.mutations().map((call) => `${call.method} ${call.route}`), [`PUT ${commandsRoute()}`, `PUT ${guildRoute(OWNER_GUILD)}`]);
  const [globalPut, guildPut] = fake.mutations();
  assert.deepEqual(names(globalPut.body), GLOBAL_NAMES);
  assert.deepEqual(names(guildPut.body), OWNER_NAMES);
  // Nothing else is touched: every request goes to the global route or the owner guild.
  assert.ok(fake.calls.every((call) => call.route === commandsRoute() || call.route === guildRoute(OWNER_GUILD)));
  assert.equal(result.readback.ok, true);
  assert.deepEqual(names(fake.commandsIn('global')), GLOBAL_NAMES);
  assert.deepEqual(names(fake.commandsIn(OWNER_GUILD)), OWNER_NAMES);
  assert.deepEqual(lines.filter((line) => !line.startsWith('[COMMAND_READBACK]')), [], 'no warning when the owner guild is set');
});

test('an owner guild that is also a private guild gets both sets of commands in one request', async (t) => {
  const host = createPrivateHost(t, { guildId: OWNER_GUILD });
  const fake = createFakeDiscord();
  const result = await deployCommands(options(fake.rest, { ownerGuildId: OWNER_GUILD, extensionHost: host }));

  // One PUT replaces a guild's whole command list, so two requests would overwrite each other.
  const guildWrites = fake.mutations().filter((call) => call.route === guildRoute(OWNER_GUILD));
  assert.equal(guildWrites.length, 1);
  assert.deepEqual(names(guildWrites[0].body), sortedNames(OWNER_NAMES, ['synthetic-tool']));
  assert.deepEqual(fake.mutations().map((call) => call.route), [commandsRoute(), guildRoute(OWNER_GUILD)]);
  assert.deepEqual(names(fake.commandsIn(OWNER_GUILD)), sortedNames(OWNER_NAMES, ['synthetic-tool']));
  assert.equal(result.readback.ok, true);
  assert.deepEqual([result.privateCommandCount, result.privateGuildCount, result.ownerDeployment.commandCount], [1, 1, OWNER_NAMES.length]);
  // The private command keeps the permissions its own definition gives it: the owner merge only adds commands.
  assert.equal(guildWrites[0].body.find((command) => command.name === 'synthetic-tool').default_member_permissions, undefined);
});

test('a name that the owner commands and a private command share is refused before anything is sent', async (t) => {
  const group = (commands) => [{ commandGroupId: 'synthetic:group', guildIds: [OWNER_GUILD], commands }];
  const privateFortune = { name: 'fortune', description: 'private', type: 1 };
  const privateTool = { name: 'synthetic-tool', description: 'private', type: 1 };
  const base = {
    clientId: APP, publicCommands: [], deploymentTargets: [], ownerGuildId: OWNER_GUILD, ownerCommands: PUBLIC.filter((command) => ownerSet.has(command.name)),
  };
  // The plan builder refuses a clash in the owner guild, and names every command that clashes.
  assert.throws(
    () => buildDeploymentPlan({ ...base, privateCommandGroups: group([privateFortune, { ...privateTool, name: 'ping' }]) }),
    (error) => error.code === 'COMMAND_OWNER_GUILD_COLLISION' && error.message.includes('/fortune, /ping')
      && error.message.includes('Nothing was deployed') && error.message.includes(OWNER_GUILD),
  );
  // The same name in another guild is not a clash: the owner commands never go there.
  const elsewhere = [{ commandGroupId: 'synthetic:group', guildIds: [OTHER_GUILD], commands: [privateFortune] }];
  assert.deepEqual(opsOf(buildDeploymentPlan({ ...base, privateCommandGroups: elsewhere })), [
    ['public-global', null], ['private-guild', OTHER_GUILD], ['owner-guild', OWNER_GUILD],
  ]);
  // Different names are merged, with the owner commands added after the private ones.
  const merged = buildDeploymentPlan({ ...base, privateCommandGroups: group([privateTool]) });
  assert.deepEqual(names(merged[1].body), sortedNames(OWNER_NAMES, ['synthetic-tool']));

  // A whole deployment refuses it too, in a dry run and in a real run, with no Discord request at all.
  const host = createPrivateHost(t, { guildId: OWNER_GUILD, commandName: 'fortune' });
  for (const dry of [true, false]) {
    const fake = createFakeDiscord();
    await assert.rejects(
      deployCommands(options(fake.rest, { ownerGuildId: OWNER_GUILD, extensionHost: host, dryRun: dry })),
      /Private slash commands collide with public commands: \/fortune$/u,
    );
    assert.equal(fake.calls.length, 0, `dryRun=${dry}`);
  }
});

test('an unset or malformed owner guild never moves the owner commands back to the global scope', async () => {
  for (const ownerGuildId of [null, '', 'not-a-guild-id', `${OWNER_GUILD},${OTHER_GUILD}`]) {
    // Discord still holds every command globally, as before this change: the deployment removes the owner ones.
    const fake = createFakeDiscord({ global: PUBLIC.map((command) => registered(command)) });
    const lines = [];
    const result = await deployCommands(options(fake.rest, { ownerGuildId, report: (line) => lines.push(line) }));

    assert.deepEqual(fake.mutations().map((call) => `${call.method} ${call.route}`), [`PUT ${commandsRoute()}`], `${ownerGuildId}`);
    assert.deepEqual(names(fake.commandsIn('global')), GLOBAL_NAMES, `${ownerGuildId}`);
    assert.deepEqual([...fake.state.keys()], ['global'], 'no guild was written');
    assert.ok(lines.some((line) => line.startsWith('[OWNER_COMMANDS] warning:')));
    assert.equal(result.ownerDeployment.commandCount, 0);
    assert.equal(result.readback.ok, true);
  }
});

test('--public-only never touches a guild route, deploys no owner command, and says so', async (t) => {
  const host = createPrivateHost(t, { guildId: OWNER_GUILD });
  const fake = createFakeDiscord();
  const lines = [];
  const result = await deployCommands(options(fake.rest, {
    publicOnly: true, ownerGuildId: OWNER_GUILD, extensionHost: host, report: (line) => lines.push(line),
  }));
  assert.deepEqual(fake.calls.map((call) => `${call.method} ${call.route}`), [
    `PUT ${commandsRoute()}`, `GET ${commandsRoute()}`,
  ], 'the global scope is written and read back, and nothing else');
  assert.deepEqual(names(fake.commandsIn('global')), GLOBAL_NAMES);
  assert.equal(result.ownerDeployment.status, 'public-only');
  assert.ok(lines.some((line) => /^\[OWNER_COMMANDS\] notice: --public-only never touches guild routes/u.test(line)));

  // Through the command line: the notice and the usual summary, and no owner line.
  const cli = [];
  const exitCode = await runDeploymentCli(['--public-only'], {
    log: (line) => cli.push(line),
    dependencies: options(createFakeDiscord().rest, { ownerGuildId: OWNER_GUILD }),
  });
  assert.equal(exitCode, 0);
  assert.ok(cli.some((line) => line.startsWith('[OWNER_COMMANDS] notice:')));
  assert.ok(cli.includes(`Slash commands deployed: ${GLOBAL_NAMES.length} public, 0 private.`));
  assert.equal(cli.some((line) => line.startsWith('Owner commands')), false);
});

test('the command line says where the owner commands went', async () => {
  const lines = [];
  const dependencies = options(createFakeDiscord().rest, { ownerGuildId: OWNER_GUILD });
  assert.equal(await runDeploymentCli([], { log: (line) => lines.push(line), dependencies }), 0);
  assert.ok(lines.includes(`Slash commands deployed: ${GLOBAL_NAMES.length} public, 0 private.`));
  assert.ok(lines.includes(`Owner commands deployed to guild:${OWNER_GUILD} only: ${OWNER_NAMES.length}.`));

  const planned = [];
  await runDeploymentCli([], { log: (line) => planned.push(line), dependencies: { ...dependencies, rest: THROWING_REST, dryRun: true } });
  assert.ok(planned.includes(`Owner commands planned (dry run) to guild:${OWNER_GUILD} only: ${OWNER_NAMES.length}.`));

  // Unset: a warning, and no line that claims a deployment.
  const unset = [];
  await runDeploymentCli([], {
    log: (line) => unset.push(line), dependencies: options(createFakeDiscord().rest, { ownerGuildId: null }),
  });
  assert.ok(unset.some((line) => line.startsWith('[OWNER_COMMANDS] warning:')));
  assert.equal(unset.some((line) => line.startsWith('Owner commands')), false);
});

test('a protected guild that would lose its private commands is not sent the owner commands', async (t) => {
  const refusedOwnerGuild = (error) => error.code === 'COMMAND_CLEANUP_REFUSED'
    && error.message.includes(`guild:${OWNER_GUILD} (owner-guild)`)
    && error.message.includes('none of its private commands')
    && error.message.includes('Load the private extension') && error.message.includes('--public-only')
    // Taking the guild off the protected list, or unsetting the variable, is not offered as a way out.
    && !/remove the guild|take .* off|unset/iu.test(error.message);
  // The owner guild is protected, but this deployment carries none of its private commands (the extension is not loaded).
  for (const dry of [true, false]) {
    const fake = createFakeDiscord();
    await assert.rejects(
      deployCommands(options(fake.rest, { ownerGuildId: OWNER_GUILD, protectedGuildIds: [OWNER_GUILD], dryRun: dry })),
      refusedOwnerGuild,
    );
    assert.equal(fake.calls.length, 0, `dryRun=${dry}`);
  }
  // The same guild with its private extension loaded: both sets go out together.
  const host = createPrivateHost(t, { guildId: OWNER_GUILD });
  const fake = createFakeDiscord();
  await deployCommands(options(fake.rest, { ownerGuildId: OWNER_GUILD, protectedGuildIds: [OWNER_GUILD], extensionHost: host }));
  assert.deepEqual(names(fake.commandsIn(OWNER_GUILD)), sortedNames(OWNER_NAMES, ['synthetic-tool']));
  // The list guards only the guilds it names. For any other owner guild the deployment makes its own check, which the
  // next tests cover; here the guild holds nothing yet, so there is nothing to lose.
  for (const protectedGuildIds of [[OTHER_GUILD], null]) {
    const plain = createFakeDiscord();
    await deployCommands(options(plain.rest, { ownerGuildId: OWNER_GUILD, protectedGuildIds }));
    assert.deepEqual(names(plain.commandsIn(OWNER_GUILD)), OWNER_NAMES, JSON.stringify(protectedGuildIds));
  }
  // --public-only never reaches the guild, so a protected owner guild does not stop it either.
  const publicOnly = createFakeDiscord();
  await deployCommands(options(publicOnly.rest, { ownerGuildId: OWNER_GUILD, protectedGuildIds: [OWNER_GUILD], publicOnly: true }));
  assert.deepEqual(publicOnly.mutations().map((call) => call.route), [commandsRoute()]);

  // A guild that the extension declares as a target without any command is still refused as a clearing operation, even
  // though the owner commands would make its body non-empty: the private commands Discord holds there would be replaced.
  const targetOnly = createExtensionHost([{ id: 'synthetic-targets', deployment: { guildIds: [OWNER_GUILD] } }]);
  for (const protectedGuildIds of [null, [OWNER_GUILD]]) {
    const refused = createFakeDiscord();
    await assert.rejects(
      deployCommands(options(refused.rest, { ownerGuildId: OWNER_GUILD, extensionHost: targetOnly, protectedGuildIds })),
      (error) => error.code === 'COMMAND_CLEANUP_REFUSED' && error.message.includes(`guild:${OWNER_GUILD} (private-guild)`),
    );
    assert.equal(refused.calls.length, 0);
  }
});

// What an owner guild may already hold. The commands are registered by someone else than this deployment: an
// extension that is not loaded in this run, or an earlier deployment of the owner commands.
const heldCommand = (name, guildId = OWNER_GUILD) => registered({ name, description: '這個伺服器原有的指令', type: 1 }, { guildId });
const ownerCommandsHeld = (guildId = OWNER_GUILD) => PUBLIC.filter((command) => ownerSet.has(command.name))
  .map((command) => registered(command, { guildId }));
const requestsOf = (fake) => fake.calls.map((call) => `${call.method} ${call.route}`);

test('an owner guild that holds commands this deployment does not carry is refused before anything is sent', async () => {
  // The private commands of a guild whose extension is not loaded in this run. The protected list does not name the guild
  // (it is unset, or it names another one), so nothing but this deployment itself keeps those commands.
  const privateCommands = ['ban', 'kick', 'synthetic-tool'];
  for (const protectedGuildIds of [null, [OTHER_GUILD]]) {
    const fake = createFakeDiscord({
      // Before this change every command was global, and the owner guild holds its own copies plus the private commands.
      global: PUBLIC.map((command) => registered(command)),
      guilds: { [OWNER_GUILD]: [...ownerCommandsHeld(), ...privateCommands.map((name) => heldCommand(name))] },
    });
    const before = fake.commandsIn(OWNER_GUILD);
    await assert.rejects(
      deployCommands(options(fake.rest, { ownerGuildId: OWNER_GUILD, protectedGuildIds })),
      (error) => error.code === 'COMMAND_OWNER_GUILD_HOLDS_OTHER_COMMANDS'
        && privateCommands.every((name) => error.message.includes(`/${name}`))
        && OWNER_NAMES.every((name) => !error.message.includes(`/${name}`))
        && before.every((command) => !error.message.includes(command.id))
        && error.message.includes(`${privateCommands.length} command(s)`)
        && error.message.includes('Nothing was deployed')
        && error.message.includes('private extension') && error.message.includes('--public-only')
        // For leftovers it names the way out that works: the server settings cannot delete a command, cleanup can.
        && error.message.includes('server settings cannot delete a command')
        && error.message.includes(`unset ${OWNER_GUILD_ENV}`) && error.message.includes('--audit --all-guilds')
        && error.message.includes('--cleanup <digest> --yes --all-guilds')
        && !/remove (?:it|the guild) from|take .* off/iu.test(error.message),
      JSON.stringify(protectedGuildIds),
    );
    // The check came first: one read of the owner guild, and not a single write, the global one included.
    assert.deepEqual(requestsOf(fake), [`GET ${guildRoute(OWNER_GUILD)}`], JSON.stringify(protectedGuildIds));
    assert.deepEqual(fake.mutations(), []);
    assert.deepEqual(fake.commandsIn(OWNER_GUILD), before, 'the guild keeps every command, with the IDs it has');
    assert.deepEqual(names(fake.commandsIn('global')), names(PUBLIC), 'the global commands were not replaced either');
  }

  // A long list is cut short, and still names nothing but commands.
  const crowded = createFakeDiscord({
    guilds: { [OWNER_GUILD]: Array.from({ length: 25 }, (_, index) => heldCommand(`private-${index}`)) },
  });
  await assert.rejects(
    deployCommands(options(crowded.rest, { ownerGuildId: OWNER_GUILD })),
    (error) => error.message.includes('25 command(s)') && error.message.includes('/private-0')
      && error.message.includes('and 5 more') && !error.message.includes('/private-24'),
  );
  assert.deepEqual(crowded.mutations(), []);

  // Commands that are not slash commands are named with their type, and a name Discord could not have is made plain:
  // every character that is not a letter, a digit, a mark, "_", "'", " " or "-" becomes "?".
  const mixed = createFakeDiscord({
    guilds: { [OWNER_GUILD]: [registered({ name: 'Report <@1> message', type: 3 }, { guildId: OWNER_GUILD })] },
  });
  await assert.rejects(
    deployCommands(options(mixed.rest, { ownerGuildId: OWNER_GUILD })),
    (error) => error.message.includes('Report ??1? message (type 3)') && !error.message.includes('<@1>'),
  );
  assert.deepEqual(mixed.mutations(), []);
});

test('leftovers in an owner guild go away through the audit and cleanup that the refusal points to', async (t) => {
  // The private guild is another one, so no group declares the owner guild. The protected list names the private guild.
  const host = createPrivateHost(t, { guildId: OTHER_GUILD });
  const leftovers = ['old-experiment', 'stale-tool'];
  const fake = createFakeDiscord({
    guilds: { [OWNER_GUILD]: [...leftovers.map((name) => heldCommand(name)), ...ownerCommandsHeld()] },
    joinedGuildIds: [OWNER_GUILD, OTHER_GUILD],
  });
  const withVariable = (extra = {}) => options(fake.rest, {
    ownerGuildId: OWNER_GUILD, extensionHost: host, protectedGuildIds: [OTHER_GUILD], ...extra,
  });
  const withoutVariable = (extra = {}) => withVariable({ ownerGuildId: null, allGuilds: true, ...extra });

  // 1. With the owner guild set, the deployment refuses, names the leftovers and writes nothing.
  await assert.rejects(
    deployCommands(withVariable()),
    (error) => error.code === 'COMMAND_OWNER_GUILD_HOLDS_OTHER_COMMANDS' && leftovers.every((name) => error.message.includes(`/${name}`)),
  );
  assert.deepEqual(fake.mutations(), []);

  // 2. With the variable unset, the audit reads every guild joined, and in a guild that the plan does not name every
  //    command is extra, so the leftovers are listed as extra and become cleanup candidates.
  const audit = await auditCommandRegistrations(withoutVariable());
  const inOwnerGuild = (items) => items.filter((item) => item.scope === `guild:${OWNER_GUILD}`);
  assert.deepEqual(names(inOwnerGuild(audit.diff.items.filter((item) => item.type === 'extra'))), sortedNames(leftovers, OWNER_NAMES));
  assert.ok(inOwnerGuild(audit.diff.items).every((item) => item.scopeKind === 'other-guild'));
  assert.deepEqual(names(inOwnerGuild(audit.cleanupCandidates)), sortedNames(leftovers, OWNER_NAMES));

  // 3. Cleanup reads the same scopes as the audit. Without --all-guilds the digest does not match and nothing is deleted.
  const forgotten = await cleanupCommandRegistrations({ ...withoutVariable({ allGuilds: false }), expectedDigest: audit.digest, confirm: true });
  assert.equal(forgotten.status, 'digest-mismatch');
  assert.deepEqual(fake.mutations(), []);

  // 4. With the same options as the audit it deletes them, one command ID at a time, in the owner guild.
  const cleanup = await cleanupCommandRegistrations({ ...withoutVariable(), expectedDigest: audit.digest, confirm: true });
  assert.equal(cleanup.status, 'deleted');
  assert.equal(fake.mutations().length, leftovers.length + OWNER_NAMES.length);
  assert.ok(fake.mutations().every((call) => call.method === 'DELETE' && call.route.startsWith(`${guildRoute(OWNER_GUILD)}/`)));
  assert.deepEqual(fake.commandsIn(OWNER_GUILD), []);

  // 5. With the variable set again the deployment goes through, and the owner guild holds the owner commands.
  await deployCommands(withVariable());
  assert.deepEqual(names(fake.commandsIn(OWNER_GUILD)), OWNER_NAMES);
});

test('that cleanup needs the private extension, a protected list and an unprotected owner guild', async (t) => {
  const leftovers = ['old-experiment'];
  const discord = () => createFakeDiscord({ guilds: { [OWNER_GUILD]: leftovers.map((name) => heldCommand(name)) }, joinedGuildIds: [OWNER_GUILD] });
  const unset = (fake, extra = {}) => options(fake.rest, { ownerGuildId: null, allGuilds: true, ...extra });

  // The public version has no private extension, so the audit lists the leftovers but cleanup refuses to delete them,
  // whether or not a protected list is set. No tool of this project removes a guild command there.
  for (const [protectedGuildIds, reason] of [
    [[OTHER_GUILD], /no private deployment plan is loaded/u],
    [null, /XIAOJI_PROTECTED_GUILD_IDS is not set/u],
  ]) {
    const fake = discord();
    const lines = [];
    const audit = await auditCommandRegistrations(unset(fake, { protectedGuildIds, report: (line) => lines.push(line) }));
    assert.deepEqual(names(audit.cleanupCandidates), leftovers, `${protectedGuildIds}`);
    for (const confirm of [false, true]) {
      await assert.rejects(
        cleanupCommandRegistrations(unset(fake, { protectedGuildIds, expectedDigest: audit.digest, confirm })),
        (error) => error.code === 'COMMAND_CLEANUP_REFUSED' && reason.test(error.message),
        `${protectedGuildIds} confirm=${confirm}`,
      );
    }
    assert.deepEqual(fake.mutations(), []);
  }

  // A guild that the protected list names is never touched: its leftovers are listed as skipped and nothing is deleted.
  const host = createPrivateHost(t, { guildId: OTHER_GUILD });
  const fake = discord();
  const protectedOwnerGuild = unset(fake, { extensionHost: host, protectedGuildIds: [OWNER_GUILD, OTHER_GUILD] });
  const audit = await auditCommandRegistrations(protectedOwnerGuild);
  assert.deepEqual(audit.cleanupCandidates, []);
  const lines = [];
  const result = await cleanupCommandRegistrations({
    ...protectedOwnerGuild, expectedDigest: audit.digest, confirm: true, report: (line) => lines.push(line),
  });
  assert.equal(result.status, 'nothing-to-delete');
  assert.ok(lines.some((line) => line.includes('skip extra') && line.includes('protected=true')));
  assert.deepEqual(fake.mutations(), []);
});

test('an owner guild that holds only owner commands is deployed to after one read that comes before every write', async () => {
  const empty = createFakeDiscord();
  // Older definitions of three owner commands are replaced by the current ones; an empty guild is no different.
  const older = PUBLIC.filter((command) => ownerSet.has(command.name)).slice(0, 3)
    .map((command) => registered({ ...command, description: '舊的說明' }, { guildId: OWNER_GUILD }));
  const stale = createFakeDiscord({ global: PUBLIC.map((command) => registered(command)), guilds: { [OWNER_GUILD]: older } });
  for (const fake of [empty, stale]) {
    const result = await deployCommands(options(fake.rest, { ownerGuildId: OWNER_GUILD }));
    assert.deepEqual(requestsOf(fake).slice(0, 3), [
      `GET ${guildRoute(OWNER_GUILD)}`, `PUT ${commandsRoute()}`, `PUT ${guildRoute(OWNER_GUILD)}`,
    ], 'the read of the owner guild is the first request of the deployment');
    assert.deepEqual(names(fake.commandsIn(OWNER_GUILD)), OWNER_NAMES);
    assert.deepEqual(names(fake.commandsIn('global')), GLOBAL_NAMES);
    assert.equal(result.readback.ok, true);
  }
  // The owner commands the guild already held are the ones replaced: their definitions are the current ones now.
  assert.equal(stale.commandsIn(OWNER_GUILD).some((command) => command.description === '舊的說明'), false);
});

test('an owner guild that cannot be read stops the deployment before the global request', async () => {
  for (const status of [403, 404]) {
    const fake = createFakeDiscord({ failures: { [guildRoute(OWNER_GUILD)]: status } });
    await assert.rejects(
      deployCommands(options(fake.rest, { ownerGuildId: OWNER_GUILD })),
      (error) => error.code === 'COMMAND_OWNER_GUILD_UNREADABLE'
        && error.message.includes(`status ${status}`)
        && error.message.includes(OWNER_GUILD_ENV) && error.message.includes('applications.commands')
        && error.message.includes('Nothing was deployed'),
      `status ${status}`,
    );
    assert.deepEqual(fake.mutations(), [], `status ${status}: the global request was not sent`);
    assert.deepEqual(requestsOf(fake), [`GET ${guildRoute(OWNER_GUILD)}`]);
  }
  // Any other failure stops it as well: a guild that cannot be read cannot be checked.
  const unavailable = createFakeDiscord({ failures: { [guildRoute(OWNER_GUILD)]: 503 } });
  await assert.rejects(
    deployCommands(options(unavailable.rest, { ownerGuildId: OWNER_GUILD })),
    (error) => error.code === 'COMMAND_OWNER_GUILD_UNREADABLE' && error.message.includes('status 503')
      && !error.message.includes(OWNER_GUILD_ENV),
  );
  assert.deepEqual(unavailable.mutations(), []);
  // So does a client that cannot read at all: nothing is written.
  const writes = [];
  const writeOnly = { put: async (route) => { writes.push(route); return []; } };
  await assert.rejects(
    deployCommands(options(writeOnly, { ownerGuildId: OWNER_GUILD })),
    (error) => error.code === 'COMMAND_OWNER_GUILD_UNREADABLE',
  );
  assert.deepEqual(writes, []);
  // And a command list that is not this application's.
  const foreign = createFakeDiscord({ guilds: { [OWNER_GUILD]: [{ ...heldCommand('ban'), application_id: '133456789012345678' }] } });
  await assert.rejects(
    deployCommands(options(foreign.rest, { ownerGuildId: OWNER_GUILD })),
    (error) => error.code === 'COMMAND_REGISTRY_FOREIGN',
  );
  assert.deepEqual(foreign.mutations(), []);
});

test('an owner guild that a private group declares is not read first and keeps the private guild semantics', async (t) => {
  const host = createPrivateHost(t, { guildId: OWNER_GUILD });
  // The guild holds a command that the extension has dropped since. Replacing it is the extension's own decision.
  const fake = createFakeDiscord({ guilds: { [OWNER_GUILD]: [heldCommand('dropped-private-tool'), ...ownerCommandsHeld()] } });
  const result = await deployCommands(options(fake.rest, { ownerGuildId: OWNER_GUILD, extensionHost: host }));
  assert.equal(fake.calls[0].method, 'PUT', 'the first request is a write: no read comes before it');
  assert.deepEqual(fake.mutations().map((call) => `${call.method} ${call.route}`), [`PUT ${commandsRoute()}`, `PUT ${guildRoute(OWNER_GUILD)}`]);
  assert.deepEqual(names(fake.commandsIn(OWNER_GUILD)), sortedNames(OWNER_NAMES, ['synthetic-tool']));
  assert.equal(result.readback.ok, true);
  // Nor is a guild that an extension only names as a deployment target, where the clearing guard decides.
  const targetOnly = createExtensionHost([{ id: 'synthetic-targets', deployment: { guildIds: [OWNER_GUILD] } }]);
  const guarded = createFakeDiscord({ guilds: { [OWNER_GUILD]: [heldCommand('ban')] } });
  await assert.rejects(
    deployCommands(options(guarded.rest, { ownerGuildId: OWNER_GUILD, extensionHost: targetOnly })),
    (error) => error.code === 'COMMAND_CLEANUP_REFUSED',
  );
  assert.equal(guarded.calls.length, 0, 'refused by the plan itself, before any read');
});

test('a dry run reads nothing and says what a real deployment checks first', async (t) => {
  const alone = await dryRun({ ownerGuildId: OWNER_GUILD });
  const notices = alone.lines.filter((line) => line.startsWith('[OWNER_COMMANDS] notice:'));
  assert.equal(notices.length, 1);
  assert.match(notices[0], /a real deployment first reads the commands Discord holds in the owner guild/u);
  assert.match(notices[0], /holds a command other than the owner commands/u);
  assert.match(notices[0], /this dry run read nothing/u);
  // The throwing client proves that no request was made. A merged guild is not read, and without an owner guild there is
  // nothing to check, so those dry runs say nothing about it.
  const host = createPrivateHost(t, { guildId: OWNER_GUILD });
  const merged = await dryRun({ ownerGuildId: OWNER_GUILD, extensionHost: host });
  const unset = await dryRun({ ownerGuildId: null });
  for (const run of [merged, unset]) assert.equal(run.lines.some((line) => line.includes('first reads')), false);
  // Through the command line as well.
  const cli = [];
  await runDeploymentCli([], {
    log: (line) => cli.push(line), dependencies: { ...options(THROWING_REST, { ownerGuildId: OWNER_GUILD }), dryRun: true },
  });
  assert.equal(cli.filter((line) => line.includes('first reads the commands Discord holds in the owner guild')).length, 1);
});

test('an owner guild that is also a legacy cleanup guild is refused, not turned into an owner commands request', async (t) => {
  const conflict = (error) => error.code === 'COMMAND_OWNER_GUILD_CLEANUP_CONFLICT'
    && error.message.includes(OWNER_GUILD) && error.message.includes('deployment.cleanupGuildIds')
    && error.message.includes('Nothing was deployed');
  // The extension lists the guild for cleanup and no command group is on it.
  const cleaning = createExtensionHost([{ id: 'synthetic-cleaning', deployment: { cleanupGuildIds: [OWNER_GUILD] } }]);
  for (const dry of [true, false]) {
    const fake = createFakeDiscord({ guilds: { [OWNER_GUILD]: [heldCommand('ban')] } });
    await assert.rejects(deployCommands(options(fake.rest, { ownerGuildId: OWNER_GUILD, extensionHost: cleaning, dryRun: dry })), conflict);
    assert.equal(fake.calls.length, 0, `dryRun=${dry}`);
  }
  // Listed through the option, and refused the same way by the audit, which plans the same deployment.
  const fake = createFakeDiscord();
  await assert.rejects(deployCommands(options(fake.rest, { ownerGuildId: OWNER_GUILD, cleanupGuildIds: [OWNER_GUILD] })), conflict);
  await assert.rejects(auditCommandRegistrations(options(fake.rest, { ownerGuildId: OWNER_GUILD, extensionHost: cleaning })), conflict);
  assert.equal(fake.calls.length, 0);
  // Without the owner guild nothing changed: the legacy cleanup keeps its own guard, which needs the protected list.
  await assert.rejects(
    deployCommands(options(fake.rest, { ownerGuildId: null, extensionHost: cleaning })),
    (error) => error.code === 'COMMAND_CLEANUP_REFUSED' && error.message.includes(`guild:${OWNER_GUILD} (cleanup-guild)`),
  );
  assert.equal(fake.calls.length, 0);
  // A guild that a private group declares is never cleared, even when it is listed. That rule is old and stays.
  const owned = createPrivateHost(t, { guildId: OWNER_GUILD, cleanupGuildIds: [OWNER_GUILD] });
  const { result } = await dryRun({ ownerGuildId: OWNER_GUILD, extensionHost: owned });
  assert.deepEqual(opsOf(result.plan), [['public-global', null], ['private-guild', OWNER_GUILD]]);
});

// A Discord that was deployed to with the given setting, and the options that audit it the same way.
async function deployedDiscord(extra = {}) {
  const fake = createFakeDiscord();
  await deployCommands(options(fake.rest, extra));
  fake.calls.length = 0;
  return fake;
}

test('the audit counts the owner guild and its owner commands as planned', async (t) => {
  const fake = await deployedDiscord({ ownerGuildId: OWNER_GUILD });
  const lines = [];
  const audit = await auditCommandRegistrations(options(fake.rest, { ownerGuildId: OWNER_GUILD, report: (line) => lines.push(line) }));

  assert.deepEqual(audit.diff.items, [], 'nothing is missing, extra or changed');
  assert.deepEqual(audit.cleanupCandidates, []);
  assert.deepEqual(audit.diff.scopes.map((scope) => [scope.scope, scope.kind, scope.expected, scope.registered]), [
    ['global', 'public-global', GLOBAL_NAMES.length, GLOBAL_NAMES.length],
    [`guild:${OWNER_GUILD}`, 'owner-guild', OWNER_NAMES.length, OWNER_NAMES.length],
  ]);
  assert.ok(lines.includes(`[COMMAND_AUDIT] scope guild:${OWNER_GUILD} kind=owner-guild expected=${OWNER_NAMES.length} registered=${OWNER_NAMES.length}`));
  assert.ok(lines.includes('[COMMAND_AUDIT] summary missing=0 extra=0 changed=0 shadow=0 tombstone=0 cleanup-candidates=0'));
  assert.deepEqual(fake.calls.map((call) => call.route), [commandsRoute(), guildRoute(OWNER_GUILD)], 'audit reads and never writes');
  assert.deepEqual(fake.mutations(), []);

  // The owner guild that is also a private guild stays a private guild, and its expected list holds both sets.
  const host = createPrivateHost(t, { guildId: OWNER_GUILD });
  const merged = await deployedDiscord({ ownerGuildId: OWNER_GUILD, extensionHost: host });
  const mergedAudit = await auditCommandRegistrations(options(merged.rest, { ownerGuildId: OWNER_GUILD, extensionHost: host }));
  assert.deepEqual(mergedAudit.diff.items, []);
  assert.deepEqual(mergedAudit.diff.scopes.map((scope) => [scope.scope, scope.kind, scope.expected]), [
    ['global', 'public-global', GLOBAL_NAMES.length],
    [`guild:${OWNER_GUILD}`, 'private-guild', OWNER_NAMES.length + 1],
  ]);

  // A command the plan does not know is reported, in both kinds of owner guild, but never offered for deletion.
  for (const [discord, extraOptions] of [[fake, {}], [merged, { extensionHost: host }]]) {
    discord.state.get(OWNER_GUILD).push(registered({ name: 'stray', description: '多出的指令', type: 1 }, { guildId: OWNER_GUILD }));
    const stray = await auditCommandRegistrations(options(discord.rest, { ownerGuildId: OWNER_GUILD, ...extraOptions }));
    assert.deepEqual(stray.diff.items.map((item) => [item.type, item.scope, item.name]), [['extra', `guild:${OWNER_GUILD}`, 'stray']]);
    assert.deepEqual(stray.cleanupCandidates, []);
  }
});

test('cleanup removes owner commands left in the global scope and never deletes in the owner guild', async (t) => {
  const stale = () => ({
    // Before this change every owner command was global, and the owner guild holds its own copy plus a stray command.
    global: PUBLIC.map((command) => registered(command)),
    guilds: {
      [OWNER_GUILD]: [
        ...PUBLIC.filter((command) => ownerSet.has(command.name)).map((command) => registered(command, { guildId: OWNER_GUILD })),
        registered({ name: 'stray', description: '多出的指令', type: 1 }, { guildId: OWNER_GUILD }),
      ],
    },
  });
  const planned = options(null, { ownerGuildId: OWNER_GUILD });
  const fake = createFakeDiscord(stale());
  const audit = await auditCommandRegistrations({ ...planned, rest: fake.rest });
  const staleGlobal = audit.diff.items.filter((item) => item.type === 'extra' && item.scope === 'global');
  assert.deepEqual(names(staleGlobal), OWNER_NAMES, 'the global copies are no longer planned');
  assert.deepEqual(audit.cleanupCandidates.map((item) => item.name).sort(), OWNER_NAMES);
  assert.ok(audit.cleanupCandidates.every((item) => item.scope === 'global'));
  // The planned owner commands in the owner guild are not extra, only the stray command is, and it is not a candidate.
  assert.deepEqual(audit.diff.items.filter((item) => item.scope === `guild:${OWNER_GUILD}` && item.type === 'extra').map((item) => item.name), ['stray']);

  const preview = await cleanupCommandRegistrations({ ...planned, rest: fake.rest, expectedDigest: audit.digest });
  assert.equal(preview.status, 'dry-run');
  assert.deepEqual(fake.mutations(), []);
  const lines = [];
  const result = await cleanupCommandRegistrations({
    ...planned, rest: fake.rest, expectedDigest: audit.digest, confirm: true, report: (line) => lines.push(line),
  });
  assert.equal(result.status, 'deleted');
  assert.deepEqual(fake.mutations().map((call) => call.method), Array(OWNER_NAMES.length).fill('DELETE'));
  assert.ok(fake.mutations().every((call) => call.route.startsWith(`${commandsRoute()}/`)), 'only global commands were deleted');
  assert.deepEqual(names(fake.commandsIn('global')), GLOBAL_NAMES);
  assert.deepEqual(names(fake.commandsIn(OWNER_GUILD)), sortedNames(OWNER_NAMES, ['stray']), 'the owner guild is untouched');
  assert.equal(lines.some((line) => /delete.*guild:/u.test(line)), false);

  // The same holds when the owner guild is also a protected private guild and every guild is read.
  const host = createPrivateHost(t, { guildId: OWNER_GUILD });
  const guarded = createFakeDiscord({ ...stale(), joinedGuildIds: [OWNER_GUILD, OTHER_GUILD] });
  const guardedOptions = options(null, {
    ownerGuildId: OWNER_GUILD, extensionHost: host, protectedGuildIds: [OWNER_GUILD], allGuilds: true,
  });
  const guardedAudit = await auditCommandRegistrations({ ...guardedOptions, rest: guarded.rest });
  const guardedResult = await cleanupCommandRegistrations({
    ...guardedOptions, rest: guarded.rest, expectedDigest: guardedAudit.digest, confirm: true,
  });
  assert.equal(guardedResult.status, 'deleted');
  assert.ok(guarded.mutations().every((call) => call.route.startsWith(`${commandsRoute()}/`)));
  assert.equal(guarded.commandsIn(OWNER_GUILD).length, OWNER_NAMES.length + 1, 'the private guild keeps every command');
});

test('a guild the plan does not name is judged like any other guild, so the owner guild must be named', async (t) => {
  const host = createPrivateHost(t, { guildId: OTHER_GUILD });
  const holdingOwnerCommands = () => createFakeDiscord({
    global: PUBLIC.filter((command) => !ownerSet.has(command.name)).map((command) => registered(command)),
    guilds: { [OWNER_GUILD]: PUBLIC.filter((command) => ownerSet.has(command.name)).map((command) => registered(command, { guildId: OWNER_GUILD })) },
    joinedGuildIds: [OWNER_GUILD],
  });
  const read = (extra) => options(null, { extensionHost: host, protectedGuildIds: [OTHER_GUILD], allGuilds: true, ...extra });
  // Named: the owner commands are planned, nothing is extra and nothing can be deleted.
  const named = holdingOwnerCommands();
  const namedAudit = await auditCommandRegistrations({ ...read({ ownerGuildId: OWNER_GUILD }), rest: named.rest });
  assert.deepEqual(namedAudit.diff.items.filter((item) => item.scope === `guild:${OWNER_GUILD}`), []);
  assert.deepEqual(namedAudit.cleanupCandidates, []);
  // Not named (the variable is unset): the same guild is an unplanned guild, and with --all-guilds it is read as one.
  const unnamed = holdingOwnerCommands();
  const unnamedAudit = await auditCommandRegistrations({ ...read({ ownerGuildId: null }), rest: unnamed.rest });
  assert.deepEqual(
    unnamedAudit.diff.items.filter((item) => item.scope === `guild:${OWNER_GUILD}`).map((item) => [item.type, item.scopeKind]).filter(([type]) => type === 'extra'),
    OWNER_NAMES.map(() => ['extra', 'other-guild']),
  );
});

test('the owner guild is refused as a cleanup target whatever else is true of it', () => {
  const target = { type: 'extra', scope: `guild:${OWNER_GUILD}`, scopeKind: 'owner-guild', name: 'stray', commandType: 1, commandId: nextId() };
  const scope = { scope: target.scope, kind: 'owner-guild', guildId: OWNER_GUILD };
  const context = {
    testControlPolicy: null, privatePlanLoaded: true, privateGuildIds: new Set(), protectedConfigured: true, protectedGuildIds: new Set(),
  };
  assert.throws(
    () => assertCleanupTarget(target, scope, context),
    (error) => error.code === 'COMMAND_CLEANUP_REFUSED' && error.message.includes('owner guild'),
  );
  // Every condition that lets another guild's leftover be deleted is present, so the kind alone refuses it.
  assert.doesNotThrow(() => assertCleanupTarget({ ...target, scopeKind: 'other-guild' }, { ...scope, kind: 'other-guild' }, context));
});

test('--public-only audit and cleanup read only the global scope, and remove owner commands left there', async () => {
  const fake = createFakeDiscord({
    global: PUBLIC.map((command) => registered(command)),
    guilds: { [OWNER_GUILD]: PUBLIC.filter((command) => ownerSet.has(command.name)).map((command) => registered(command, { guildId: OWNER_GUILD })) },
  });
  const publicOnly = options(null, { publicOnly: true, ownerGuildId: OWNER_GUILD });
  const audit = await auditCommandRegistrations({ ...publicOnly, rest: fake.rest });
  assert.deepEqual(audit.diff.scopes.map((scope) => scope.scope), ['global']);
  assert.deepEqual(names(audit.cleanupCandidates), OWNER_NAMES);
  const result = await cleanupCommandRegistrations({ ...publicOnly, rest: fake.rest, expectedDigest: audit.digest, confirm: true });
  assert.equal(result.status, 'deleted');
  assert.deepEqual(names(fake.commandsIn('global')), GLOBAL_NAMES);
  assert.equal(fake.calls.some((call) => call.route.includes(OWNER_GUILD)), false, 'no request ever names the owner guild');
});

test('a test-control deployment never sends an owner command to the global scope, whatever the owner guild setting is', async (t) => {
  const fixture = createFixture({ XIAOJI_TEST_ALLOWED_COMMANDS: `ping,${OWNER_NAMES.join(',')}`, XIAOJI_TEST_ALLOWED_GUILD_IDS: `${IDS.guild},${IDS.otherGuild}` });
  t.after(() => fixture.cleanup());
  const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
  const globalRoute = `/applications/${IDS.app}/commands`;
  const testGuildRoutes = [IDS.guild, IDS.otherGuild].map((guildId) => `/applications/${IDS.app}/guilds/${guildId}/commands`);
  const testControl = (rest, extra = {}) => ({
    token: TOKEN, clientId: IDS.app, rest, testControl: true, testControlPolicy: policy, protectedGuildIds: null, report: () => {}, ...extra,
  });

  for (const ownerGuildId of [null, '', 'not-a-guild-id', OWNER_GUILD, IDS.guild, IDS.otherGuild]) {
    const planned = await deployCommands(testControl(THROWING_REST, { dryRun: true, ownerGuildId }));
    assert.ok(planned.plan.length > 0 && planned.plan.every((operation) => operation.kind === 'test-guild'), `${ownerGuildId}`);
    assert.ok(planned.plan.every((operation) => testGuildRoutes.includes(operation.route) && operation.route !== globalRoute), `${ownerGuildId}`);
    assert.ok(planned.plan.every((operation) => operation.guildId !== OWNER_GUILD), 'the production owner guild is never a test target');
    assert.equal(planned.globalCount, 0);
    assert.equal(planned.ownerDeployment, undefined, 'test-control does not read the owner guild at all');
  }

  // A real run, against a fake of the test application, writes only to the trusted test guilds' routes.
  const puts = [];
  const held = new Map();
  const testApplication = {
    async get(route) {
      if (route === '/oauth2/applications/@me' || route === '/users/%40me') return { id: IDS.app };
      if (route.startsWith('/guilds/')) return { id: route.slice('/guilds/'.length) };
      if (route.startsWith('/channels/')) return { id: route.slice('/channels/'.length), guild_id: IDS.guild };
      if (testGuildRoutes.includes(route)) {
        return (held.get(route) || []).map((command) => ({ ...command, application_id: IDS.app, guild_id: route.split('/')[4] }));
      }
      throw httpError(404);
    },
    async put(route, { body }) {
      puts.push({ route, names: names(body) });
      held.set(route, body.map((command) => ({ ...clone(command), id: nextId() })));
      return [];
    },
  };
  await deployCommands(testControl(testApplication, { ownerGuildId: OWNER_GUILD }));
  assert.deepEqual(puts.map((put) => put.route).sort(), [...testGuildRoutes].sort());
  assert.ok(puts.every((put) => put.route !== globalRoute));
  // The owner commands the policy allows reach the trusted test guilds, as before; they are hidden there like anywhere.
  assert.ok(puts.every((put) => OWNER_NAMES.every((name) => put.names.includes(name))));

  // The plan builder itself has no global route: it only ever builds guild operations for the trusted test guilds.
  const plan = buildTestDeploymentPlan({ policy, publicCommands: PUBLIC });
  assert.ok(plan.every((operation) => operation.kind === 'test-guild' && operation.route !== globalRoute));

  // The audit reads only the test guilds too, even when the owner guild is configured.
  const audit = await auditCommandRegistrations(testControl(testApplication, { ownerGuildId: OWNER_GUILD }));
  assert.deepEqual(audit.diff.scopes.map((scope) => scope.kind), ['test-guild', 'test-guild']);
  assert.deepEqual(audit.diff.items, []);
});

test('the deployment reads the owner guild from the environment, as the startup deployment does', async () => {
  // src/index.js calls deployCommands({ extensionHost }) with nothing else, so the value has to come from here.
  const previous = process.env[OWNER_GUILD_ENV];
  const environmentOptions = (fake, lines) => {
    const given = options(fake.rest, { report: (line) => lines.push(line) });
    delete given.ownerGuildId;
    return given;
  };
  try {
    process.env[OWNER_GUILD_ENV] = OWNER_GUILD;
    const set = createFakeDiscord();
    await deployCommands(environmentOptions(set, []));
    assert.deepEqual(set.mutations().map((call) => call.route), [commandsRoute(), guildRoute(OWNER_GUILD)]);
    assert.deepEqual(names(set.commandsIn(OWNER_GUILD)), OWNER_NAMES);

    delete process.env[OWNER_GUILD_ENV];
    const unsetLines = [];
    const unset = createFakeDiscord();
    await deployCommands(environmentOptions(unset, unsetLines));
    assert.deepEqual(unset.mutations().map((call) => call.route), [commandsRoute()]);
    assert.ok(unsetLines.some((line) => line.startsWith('[OWNER_COMMANDS] warning:')));

    process.env[OWNER_GUILD_ENV] = 'not-a-guild-id';
    const invalidLines = [];
    const invalid = createFakeDiscord();
    await deployCommands(environmentOptions(invalid, invalidLines));
    assert.deepEqual(invalid.mutations().map((call) => call.route), [commandsRoute()]);
    assert.ok(invalidLines.some((line) => line.startsWith('[OWNER_COMMANDS] warning:')));
    assert.ok(invalidLines.every((line) => !line.includes('not-a-guild-id')));

    // Audit and cleanup read the same variable.
    process.env[OWNER_GUILD_ENV] = OWNER_GUILD;
    const audit = await auditCommandRegistrations(environmentOptions(set, []));
    assert.deepEqual(audit.diff.scopes.map((scope) => scope.scope), ['global', `guild:${OWNER_GUILD}`]);
  } finally {
    if (previous === undefined) delete process.env[OWNER_GUILD_ENV];
    else process.env[OWNER_GUILD_ENV] = previous;
  }
});

// Loaded with --require before src/index.js: no socket can open, every Discord REST request is recorded and answered
// with an empty list, and login is a probe. The data preflight, which needs a fully initialized data directory, is
// skipped so that startup reaches AUTO_DEPLOY_COMMANDS.
const STARTUP_PRELOAD = String.raw`'use strict';
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
REST.prototype.request = async function recordedRequest(options) {
  const names = Array.isArray(options.body) ? options.body.map((command) => command.name).sort() : [];
  process.stdout.write('XIAOJI_TEST_REST_REQUEST ' + JSON.stringify({ method: options.method, route: options.fullRoute, names }) + '\n');
  return options.method === 'GET' ? [] : options.body;
};
const { Client } = require(require.resolve('discord.js', { paths: [root] }));
Client.prototype.login = async function blockedLogin() {
  process.stdout.write('XIAOJI_TEST_LOGIN\n');
  throw new Error('XIAOJI_TEST_LOGIN_BLOCKED');
};
const preflightPath = require.resolve(path.join(root, 'src', 'platform', 'runtimeDataPreflight.js'));
const preflight = require(preflightPath);
require.cache[preflightPath].exports = { ...preflight, preflightRuntimeData: async () => {} };
`;
const STARTUP_PARENT_KEYS = new Set([
  'COMSPEC', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR',
]);

test('with AUTO_DEPLOY_COMMANDS the real startup of the public core deploys the global commands alone, whatever the owner guild setting is', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-owner-guild-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // An empty working directory, so dotenv finds no .env file.
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd);
  const preload = path.join(root, 'preload.js');
  fs.writeFileSync(preload, STARTUP_PRELOAD);
  const parentEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => STARTUP_PARENT_KEYS.has(key.toUpperCase())));
  const start = (ownerGuildId) => {
    const run = spawnSync(process.execPath, ['--require', preload, path.join(PROJECT_ROOT, 'src', 'index.js')], {
      cwd,
      encoding: 'utf8',
      shell: false,
      timeout: 120_000,
      windowsHide: true,
      env: {
        ...parentEnv,
        XIAOJI_STARTUP_TEST_ROOT: PROJECT_ROOT,
        AUTO_DEPLOY_COMMANDS: 'true',
        DISCORD_TOKEN: TOKEN,
        DISCORD_CLIENT_ID: APP,
        BOT_OWNER_ID: OTHER_GUILD,
        ...(ownerGuildId === null ? {} : { [OWNER_GUILD_ENV]: ownerGuildId }),
      },
    });
    assert.equal(run.signal, null, 'startup must end by itself');
    const requests = run.stdout.split('\n').filter((line) => line.startsWith('XIAOJI_TEST_REST_REQUEST '))
      .map((line) => JSON.parse(line.slice('XIAOJI_TEST_REST_REQUEST '.length)));
    return { run, requests, writes: requests.filter((request) => request.method !== 'GET') };
  };

  // The public core has no owner-only command and loads no extension here, so the owner guild changes nothing:
  // one write, the global one, no read or write of the owner guild, and no owner warning.
  const allNames = names(PUBLIC);
  for (const ownerGuildId of [OWNER_GUILD, null, 'not-a-guild-id']) {
    const started = start(ownerGuildId);
    assert.deepEqual(started.writes.map((request) => [request.method, request.route]), [['PUT', commandsRoute()]], String(ownerGuildId));
    assert.deepEqual(started.writes[0].names, allNames, 'the global body has every public command');
    assert.equal(started.requests.some((request) => request.route === guildRoute(OWNER_GUILD)), false, 'the owner guild is never touched');
    assert.equal(started.run.stdout.includes('[OWNER_COMMANDS]'), false, 'there is nothing to warn about');
    assert.equal(started.run.stdout.includes('XIAOJI_TEST_LOGIN'), true, 'startup went on to log in after the deployment');
    assert.equal(`${started.run.stdout}${started.run.stderr}`.includes(TOKEN), false);
    assert.equal(`${started.run.stdout}${started.run.stderr}`.includes('not-a-guild-id'), false, 'a bad value is never echoed');
  }
});

test('the example environment and the readme explain the owner guild without naming a real guild', () => {
  const exampleLines = fs.readFileSync(path.join(PROJECT_ROOT, '.env.example'), 'utf8').split(/\r?\n/u);
  const at = exampleLines.findIndex((line) => line.startsWith(`${OWNER_GUILD_ENV}=`));
  assert.ok(at > 0, 'the example names the variable');
  assert.equal(exampleLines[at], `${OWNER_GUILD_ENV}=`, 'the example value is blank, so copying it deploys the owner commands nowhere');
  // The comment is the block of comment lines right above the assignment.
  const comment = [];
  for (let index = at - 1; index >= 0 && exampleLines[index].startsWith('#'); index -= 1) comment.unshift(exampleLines[index]);
  const text = comment.join('\n');
  assert.ok(comment.length >= 5, 'the variable is explained');
  assert.match(text, /never globally/u);
  assert.match(text, /Administrators only/u);
  assert.doesNotMatch(text, /\d{16}/u, 'no guild ID is written in the example');
  const readme = fs.readFileSync(path.join(PROJECT_ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(OWNER_GUILD_ENV));
  assert.ok(!/XIAOJI_OWNER_GUILD_ID=\d/u.test(readme), 'the readme gives no real value');
});

test('the public export lists this test', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'public-export', 'manifest.json'), 'utf8'));
  assert.ok(manifest.paths.includes('test/ownerGuildDeployment.test.js'));
});
