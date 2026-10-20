'use strict';

// Command registry audit, cleanup and deployment readback. Every Discord call goes to an
// in-memory fake; no test opens a network connection.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertCleanupTarget,
  auditCommandRegistrations,
  cleanupCommandRegistrations,
  deployCommands,
  parseDeploymentArgs,
  reportCliFailure,
  runDeploymentCli,
} = require('../deploy-commands');
const { createExtensionHost } = require('../src/extensions/extensionHost');
const { loadCommandData, loadPrivateCommandGroups } = require('../src/loadCommands');
const {
  computeRegistryDiff,
  createSafeWriter,
  listJoinedGuildIds,
  normalizeCommandForHash,
  parseProtectedGuildIds,
  selectCleanupTargets,
} = require('../src/platform/commandRegistryAudit');
const { loadTestControlPolicy } = require('../src/platform/testControlPolicy');
const commandCatalog = require('../website/commandCatalog');
const { IDS, createFixture } = require('./testControlSupport');

const APP = '123456789012345678';
const PRIVATE_GUILD = '223456789012345678';
const CLEANUP_GUILD = '323456789012345678';
const OTHER_GUILD = '423456789012345678';
const SECOND_OTHER_GUILD = '523456789012345678';
// A private guild the private extension forgot to declare.
const UNDECLARED_PRIVATE_GUILD = '623456789012345678';
const TOKEN = 'synthetic-audit-token-0123456789';
// Built at run time so this file never contains a token-shaped literal.
const TOKEN_SHAPED = ['M'.padEnd(24, 'x'), 'y'.repeat(6), 'z'.repeat(27)].join('.');
const PUBLIC = loadCommandData(undefined, { scope: 'public' });
// A whole command whose catalog audience is "owner" is never global: it goes to the owner guild only
// (test/ownerGuildDeployment.test.js covers that). What models the global scope here uses GLOBAL.
const OWNER_NAMES = new Set(commandCatalog.COMMAND_CATALOG.filter((entry) => entry.audience === 'owner').map((entry) => entry.name));
const GLOBAL = PUBLIC.filter((command) => !OWNER_NAMES.has(command.name));

const clone = (value) => JSON.parse(JSON.stringify(value));
const byName = (name) => PUBLIC.find((command) => command.name === name);
const commandsRoute = (applicationId = APP) => `/applications/${applicationId}/commands`;
const guildRoute = (guildId, applicationId = APP) => `/applications/${applicationId}/guilds/${guildId}/commands`;

let lastId = 900000000000000000n;
function nextId() {
  lastId += 1n;
  return String(lastId);
}

// Mirrors Discord's answers: ids and versions added, false flags and empty option lists
// left out, unset localizations as null, global-only fields filled with defaults.
function discordOption(option) {
  const result = { ...option };
  if (result.required === false) delete result.required;
  if (result.autocomplete === false) delete result.autocomplete;
  delete result.name_localizations;
  delete result.description_localizations;
  if (Array.isArray(result.options)) {
    if (result.options.length === 0) delete result.options;
    else result.options = result.options.map(discordOption);
  }
  return result;
}

function asRegistered(command, { applicationId = APP, guildId = null, id = nextId() } = {}) {
  const registered = {
    id,
    application_id: applicationId,
    version: nextId(),
    default_member_permissions: command.default_member_permissions ?? null,
    type: command.type ?? 1,
    name: command.name,
    name_localizations: command.name_localizations ?? null,
    description: command.description ?? '',
    description_localizations: command.description_localizations ?? null,
    nsfw: command.nsfw ?? false,
  };
  if (guildId) {
    registered.guild_id = guildId;
  } else {
    registered.dm_permission = command.dm_permission ?? true;
    registered.contexts = command.contexts ?? null;
    registered.integration_types = command.integration_types ?? [0];
  }
  const options = (command.options || []).map(discordOption);
  if (options.length > 0) registered.options = options;
  return registered;
}

function httpError(status) {
  return Object.assign(new Error(`synthetic HTTP ${status}`), { status });
}

function createFakeDiscord({
  applicationId = APP,
  global = [],
  guilds = {},
  joinedGuildIds = [],
  identity = null,
  deleteBehavior = {},
  putFilter = (body) => body,
} = {}) {
  const state = new Map([['global', global.map(clone)]]);
  for (const [guildId, commands] of Object.entries(guilds)) state.set(guildId, commands.map(clone));
  const listOf = (key) => {
    if (!state.has(key)) state.set(key, []);
    return state.get(key);
  };
  const calls = [];
  const guildCommands = new RegExp(`^/applications/${applicationId}/guilds/(\\d+)/commands$`);
  const globalCommand = new RegExp(`^/applications/${applicationId}/commands/(\\d+)$`);
  const guildCommand = new RegExp(`^/applications/${applicationId}/guilds/(\\d+)/commands/(\\d+)$`);
  const rest = {
    async get(route, options = {}) {
      calls.push({ method: 'GET', route, query: options.query ? options.query.toString() : '' });
      if (route === commandsRoute(applicationId)) return clone(listOf('global'));
      const guildMatch = route.match(guildCommands);
      if (guildMatch) return clone(listOf(guildMatch[1]));
      if (route === '/users/@me/guilds') {
        const limit = Number(options.query.get('limit'));
        const after = options.query.get('after');
        return [...joinedGuildIds]
          .sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : 1))
          .filter((guildId) => !after || BigInt(guildId) > BigInt(after))
          .slice(0, limit)
          .map((guildId) => ({ id: guildId, name: 'synthetic guild' }));
      }
      if (identity) {
        if (route === '/oauth2/applications/@me') return { id: identity.applicationId };
        if (route === '/users/%40me') return { id: identity.botUserId };
        if (route.startsWith('/guilds/')) return { id: route.slice('/guilds/'.length) };
        if (route.startsWith('/channels/')) return { id: route.slice('/channels/'.length), guild_id: identity.channelGuildId };
      }
      throw httpError(404);
    },
    async put(route, { body }) {
      calls.push({ method: 'PUT', route });
      const guildMatch = route.match(guildCommands);
      if (route !== commandsRoute(applicationId) && !guildMatch) throw httpError(404);
      const key = guildMatch ? guildMatch[1] : 'global';
      const guildId = guildMatch ? guildMatch[1] : null;
      state.set(key, putFilter(body, key).map((command) => asRegistered(command, { applicationId, guildId })));
      return clone(state.get(key));
    },
    async delete(route) {
      calls.push({ method: 'DELETE', route });
      if (deleteBehavior[route] === 'fail') throw httpError(500);
      const globalMatch = route.match(globalCommand);
      const guildMatch = route.match(guildCommand);
      if (!globalMatch && !guildMatch) throw httpError(404);
      if (deleteBehavior[route] === 'ignore') return undefined;
      const list = listOf(globalMatch ? 'global' : guildMatch[1]);
      const id = globalMatch ? globalMatch[1] : guildMatch[2];
      const index = list.findIndex((command) => command.id === id);
      if (index < 0) throw httpError(404);
      list.splice(index, 1);
      return undefined;
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

// A loaded private extension: one private command for PRIVATE_GUILD and CLEANUP_GUILD as
// its declared legacy cleanup target.
function createPrivateHost(t, { cleanupGuildIds = [CLEANUP_GUILD] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-command-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'commands');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'synthetic-tool.js'), [
    `const { SlashCommandBuilder } = require(${JSON.stringify(require.resolve('discord.js'))});`,
    'module.exports = {',
    "  data: new SlashCommandBuilder().setName('synthetic-tool').setDescription('synthetic private tool')",
    "    .addSubcommand((sub) => sub.setName('run').setDescription('run the synthetic tool')),",
    '  async execute() {},',
    '};',
  ].join('\n'));
  return createExtensionHost([{
    id: 'synthetic-private',
    commandDirectories: [{ path: directory, guildIds: [PRIVATE_GUILD] }],
    deployment: { cleanupGuildIds },
  }]);
}

function privateCommandsOf(host) {
  return loadPrivateCommandGroups(host).flatMap((group) => group.commands);
}

// Global: /ping missing, /roll changed, /casino carries removed `dice`, old /games extra.
// Private guild: its own command plus a stray /help. Cleanup guild: an old /games.
function createDriftedDiscord(host, extra = {}) {
  const ids = { roll: nextId(), casino: nextId(), games: nextId(), help: nextId(), privateTool: nextId(), privateHelp: nextId(), cleanupGames: nextId() };
  const oldGames = { name: 'games', description: '舊版遊戲入口', type: 1, options: [{ type: 1, name: 'menu', description: '舊版選單' }] };
  const global = GLOBAL.filter((command) => command.name !== 'ping').map((command) => {
    if (command.name === 'roll') return asRegistered({ ...command, description: '舊的擲骰說明' }, { id: ids.roll });
    if (command.name === 'casino') {
      return asRegistered({ ...command, options: [...command.options, { type: 1, name: 'dice', description: '舊版骰子' }] }, { id: ids.casino });
    }
    if (command.name === 'help') return asRegistered(command, { id: ids.help });
    return asRegistered(command);
  });
  global.push(asRegistered(oldGames, { id: ids.games }));
  const [privateTool] = privateCommandsOf(host);
  const fake = createFakeDiscord({
    global,
    guilds: {
      [PRIVATE_GUILD]: [
        asRegistered(privateTool, { guildId: PRIVATE_GUILD, id: ids.privateTool }),
        asRegistered(byName('help'), { guildId: PRIVATE_GUILD, id: ids.privateHelp }),
      ],
      [CLEANUP_GUILD]: [asRegistered(oldGames, { guildId: CLEANUP_GUILD, id: ids.cleanupGames })],
      ...extra.guilds,
    },
    joinedGuildIds: extra.joinedGuildIds || [],
    deleteBehavior: extra.deleteBehavior ? extra.deleteBehavior(ids) : {},
  });
  return { fake, ids };
}

// protectedGuildIds and ownerGuildId: null pin "not configured", whatever the developer's environment holds.
function productionOptions(fake, host, report) {
  return {
    token: TOKEN, clientId: APP, rest: fake.rest, extensionHost: host, testControlPolicy: null, protectedGuildIds: null, ownerGuildId: null, report,
  };
}

// The intended production setup: the private guild is protected, so guild cleanup may run.
function guardedOptions(fake, host, report) {
  return { ...productionOptions(fake, host, report), protectedGuildIds: [PRIVATE_GUILD] };
}

test('a registered command hashes like its builder once Discord-only fields are ignored', () => {
  const diff = computeRegistryDiff({
    applicationId: APP,
    scopes: [{ kind: 'public-global', expected: PUBLIC, actual: PUBLIC.map((command) => asRegistered(command)) }],
  });
  assert.deepEqual(diff.items, [], 'every public builder must match its Discord form');

  const builder = {
    name: 'sample',
    description: '範例',
    type: 1,
    options: [
      { type: 3, name: 'text', description: '文字', required: false, name_localizations: undefined },
      { type: 7, name: 'channel', description: '頻道', required: true, channel_types: [5, 0] },
      { type: 1, name: 'sub', description: '子指令', options: [] },
    ],
  };
  const registered = {
    id: '987654321098765432',
    application_id: APP,
    version: '987654321098765433',
    guild_id: null,
    default_member_permissions: null,
    nsfw: false,
    name_localizations: null,
    description_localizations: {},
    name_localized: 'sample',
    ...clone(builder),
  };
  registered.options[0] = { type: 3, name: 'text', description: '文字', name_localizations: null };
  registered.options[1] = { ...registered.options[1], channel_types: [0, 5] };
  registered.options[2] = { type: 1, name: 'sub', description: '子指令' };
  const normalized = (command, options) => JSON.stringify(normalizeCommandForHash(command, options));
  assert.equal(normalized(registered), normalized(builder));
  assert.notEqual(normalized({ ...registered, description: '不同' }), normalized(builder));
  assert.notEqual(normalized({ ...registered, options: [...registered.options].reverse() }), normalized(builder));
  assert.notEqual(normalized({ ...registered, default_member_permissions: '8' }), normalized(builder));

  // Global-only defaults count only when the builder sets them, and never in a guild.
  const dmOff = { ...builder, dm_permission: false };
  const fields = { globalScope: true, globalFields: ['dm_permission'] };
  assert.equal(normalized({ ...registered, dm_permission: false }, fields), normalized(dmOff, fields));
  assert.equal(normalized({ ...registered, dm_permission: false, contexts: null }, fields), normalized(dmOff, fields));
  // Discord may express "not in DMs" through contexts instead of the deprecated flag.
  assert.equal(normalized({ ...registered, dm_permission: true, contexts: [0] }, fields), normalized(dmOff, fields));
  assert.notEqual(normalized({ ...registered, dm_permission: true }, fields), normalized(dmOff, fields));
  assert.notEqual(normalized({ ...registered, dm_permission: false, contexts: [2, 1, 0] }, fields), normalized(dmOff, fields));
  assert.equal(normalized({ ...registered, dm_permission: true, contexts: [0, 1, 2], integration_types: [0] }), normalized(builder));
  assert.equal(
    normalized({ ...registered, dm_permission: true }, { globalScope: false, globalFields: ['dm_permission'] }),
    normalized(dmOff, { globalScope: false, globalFields: ['dm_permission'] }),
  );
});

test('the difference list classifies every kind with scope and command ID, and the digest is stable', (t) => {
  const host = createPrivateHost(t);
  const [privateTool] = privateCommandsOf(host);
  const { fake, ids } = createDriftedDiscord(host);
  const scopes = () => [
    { kind: 'public-global', expected: GLOBAL, actual: fake.commandsIn('global') },
    { kind: 'private-guild', guildId: PRIVATE_GUILD, expected: [privateTool], actual: fake.commandsIn(PRIVATE_GUILD) },
    { kind: 'cleanup-guild', guildId: CLEANUP_GUILD, expected: [], actual: fake.commandsIn(CLEANUP_GUILD) },
  ];
  const diff = computeRegistryDiff({ applicationId: APP, scopes: scopes(), removedPaths: ['games', 'casino dice'] });
  const summary = diff.items.map((item) => [item.type, item.scope, item.name, item.commandId ?? null, item.path ?? null]);
  assert.deepEqual(summary, [
    ['missing', 'global', 'ping', null, null],
    ['extra', 'global', 'games', ids.games, null],
    ['changed', 'global', 'casino', ids.casino, null],
    ['changed', 'global', 'roll', ids.roll, null],
    ['tombstone', 'global', 'casino', ids.casino, 'casino dice'],
    ['tombstone', 'global', 'games', ids.games, 'games'],
    ['extra', `guild:${PRIVATE_GUILD}`, 'help', ids.privateHelp, null],
    ['shadow', `guild:${PRIVATE_GUILD}`, 'help', ids.privateHelp, null],
    ['extra', `guild:${CLEANUP_GUILD}`, 'games', ids.cleanupGames, null],
    ['shadow', `guild:${CLEANUP_GUILD}`, 'games', ids.cleanupGames, null],
    ['tombstone', `guild:${CLEANUP_GUILD}`, 'games', ids.cleanupGames, 'games'],
  ]);
  assert.deepEqual(diff.counts, { missing: 1, extra: 3, changed: 2, shadow: 2, tombstone: 3 });
  assert.equal(diff.items.find((item) => item.type === 'shadow' && item.name === 'help').globalCommandId, ids.help);
  assert.match(diff.digest, /^[a-f0-9]{64}$/u);

  // Only extra commands outside private guilds are cleanup candidates.
  assert.deepEqual(selectCleanupTargets(diff).map((item) => item.commandId), [ids.games, ids.cleanupGames]);

  // The digest ignores input order but follows every registered ID and the application.
  const reordered = scopes().reverse().map((scope) => ({ ...scope, actual: [...scope.actual].reverse() }));
  assert.equal(computeRegistryDiff({ applicationId: APP, scopes: reordered, removedPaths: ['casino dice', 'games'] }).digest, diff.digest);
  const otherApp = computeRegistryDiff({ applicationId: '133456789012345678', scopes: scopes(), removedPaths: ['games', 'casino dice'] });
  assert.notEqual(otherApp.digest, diff.digest);
  const renumbered = scopes();
  renumbered[2].actual[0].id = nextId();
  assert.notEqual(computeRegistryDiff({ applicationId: APP, scopes: renumbered, removedPaths: ['games', 'casino dice'] }).digest, diff.digest);
});

test('audit only reads the declared scopes and prints IDs, scopes and the digest last', async (t) => {
  const host = createPrivateHost(t);
  const { fake, ids } = createDriftedDiscord(host, { joinedGuildIds: [PRIVATE_GUILD, OTHER_GUILD] });
  const lines = [];
  const result = await auditCommandRegistrations(productionOptions(fake, host, (line) => lines.push(line)));

  assert.deepEqual(fake.mutations(), [], 'audit never writes');
  assert.deepEqual(fake.calls.map((call) => call.route), [commandsRoute(), guildRoute(PRIVATE_GUILD), guildRoute(CLEANUP_GUILD)]);
  assert.ok(fake.calls.every((call) => call.query === 'with_localizations=true'));
  assert.equal(lines.at(-1), `[COMMAND_AUDIT] digest ${result.digest}`);
  assert.ok(lines.includes(`[COMMAND_AUDIT] extra scope=global kind=public-global name="/games" id=${ids.games}`));
  assert.ok(lines.includes(`[COMMAND_AUDIT] tombstone scope=global kind=public-global name="/casino" id=${ids.casino} path="/casino dice"`));
  assert.ok(lines.some((line) => line.startsWith(`[COMMAND_AUDIT] shadow scope=guild:${PRIVATE_GUILD} kind=private-guild name="/help" id=${ids.privateHelp} global-id=${ids.help}`)));
  assert.ok(lines.includes('[COMMAND_AUDIT] summary missing=1 extra=3 changed=2 shadow=2 tombstone=3 cleanup-candidates=2'));

  // --all-guilds adds every joined guild the plan does not declare, read-only as well.
  const allLines = [];
  const all = await auditCommandRegistrations({ ...productionOptions(fake, host, (line) => allLines.push(line)), allGuilds: true });
  assert.deepEqual(fake.mutations(), []);
  assert.ok(fake.calls.some((call) => call.route === '/users/@me/guilds'));
  assert.ok(fake.calls.some((call) => call.route === guildRoute(OTHER_GUILD)));
  assert.ok(all.diff.scopes.some((scope) => scope.scope === `guild:${OTHER_GUILD}` && scope.kind === 'other-guild'));
  assert.ok(all.diff.scopes.some((scope) => scope.scope === `guild:${PRIVATE_GUILD}` && scope.kind === 'private-guild'));
  assert.notEqual(all.digest, result.digest, 'the digest records which scopes were read');
});

test('joined guilds are listed page by page and a stuck page fails closed', async () => {
  const fake = createFakeDiscord({ joinedGuildIds: [SECOND_OTHER_GUILD, OTHER_GUILD, PRIVATE_GUILD] });
  const ids = await listJoinedGuildIds({ rest: fake.rest, route: '/users/@me/guilds', pageSize: 2 });
  assert.deepEqual(ids, [PRIVATE_GUILD, OTHER_GUILD, SECOND_OTHER_GUILD]);
  assert.deepEqual(fake.calls.map((call) => call.query), ['limit=2', `limit=2&after=${OTHER_GUILD}`]);

  const stuck = { async get() { return [{ id: OTHER_GUILD }, { id: PRIVATE_GUILD }]; } };
  await assert.rejects(
    listJoinedGuildIds({ rest: stuck, route: '/users/@me/guilds', pageSize: 2, maxPages: 3 }),
    (error) => error.code === 'COMMAND_REGISTRY_READ_INVALID',
  );
});

test('audit refuses foreign or malformed command lists before reporting', async (t) => {
  const host = createPrivateHost(t);
  const foreign = createFakeDiscord({ global: [asRegistered(byName('ping'), { applicationId: '133456789012345678' })] });
  await assert.rejects(
    auditCommandRegistrations(productionOptions(foreign, host, () => {})),
    (error) => error.code === 'COMMAND_REGISTRY_FOREIGN',
  );
  const malformed = createFakeDiscord({ global: [{ ...asRegistered(byName('ping')), id: '../1' }] });
  await assert.rejects(
    auditCommandRegistrations(productionOptions(malformed, host, () => {})),
    (error) => error.code === 'COMMAND_REGISTRY_READ_INVALID',
  );
  assert.deepEqual([...foreign.mutations(), ...malformed.mutations()], []);
});

test('cleanup refuses a digest that no longer matches and prints the new digest', async (t) => {
  const host = createPrivateHost(t);
  const { fake } = createDriftedDiscord(host);
  const audit = await auditCommandRegistrations(productionOptions(fake, host, () => {}));
  fake.state.get('global').push(asRegistered({ name: 'stray', description: '多出的指令', type: 1 }));

  const lines = [];
  const result = await cleanupCommandRegistrations({
    ...productionOptions(fake, host, (line) => lines.push(line)), expectedDigest: audit.digest, confirm: true,
  });
  assert.equal(result.status, 'digest-mismatch');
  assert.notEqual(result.currentDigest, audit.digest);
  assert.deepEqual(fake.mutations(), []);
  assert.equal(lines.at(-1), `[COMMAND_CLEANUP] current digest ${result.currentDigest}`);
  const fresh = await auditCommandRegistrations(productionOptions(fake, host, () => {}));
  assert.equal(fresh.digest, result.currentDigest);

  await assert.rejects(
    cleanupCommandRegistrations({ ...productionOptions(fake, host, () => {}), expectedDigest: 'not-a-digest', confirm: true }),
    /64-character digest/u,
  );
  assert.deepEqual(fake.mutations(), []);
});

test('cleanup without --yes only lists what it would delete', async (t) => {
  const host = createPrivateHost(t);
  const { fake, ids } = createDriftedDiscord(host);
  const audit = await auditCommandRegistrations(guardedOptions(fake, host, () => {}));
  const lines = [];
  const result = await cleanupCommandRegistrations({
    ...guardedOptions(fake, host, (line) => lines.push(line)), expectedDigest: audit.digest,
  });
  assert.equal(result.status, 'dry-run');
  assert.deepEqual(result.targets.map((target) => target.commandId), [ids.games, ids.cleanupGames]);
  assert.deepEqual(fake.mutations(), []);
  assert.ok(lines.includes(`[COMMAND_CLEANUP] would delete extra scope=global kind=public-global name="/games" id=${ids.games}`));
  assert.ok(lines.at(-1).includes('add --yes to delete 2 command(s). Nothing was deleted.'));
});

test('cleanup deletes only global and non-private leftovers by ID, never a private guild, then reads back', async (t) => {
  const host = createPrivateHost(t);
  const strayOther = asRegistered({ name: 'old-tool', description: '舊工具', type: 1 }, { guildId: OTHER_GUILD });
  const { fake, ids } = createDriftedDiscord(host, {
    guilds: { [OTHER_GUILD]: [strayOther] },
    joinedGuildIds: [PRIVATE_GUILD, CLEANUP_GUILD, OTHER_GUILD],
  });
  const privateBefore = fake.commandsIn(PRIVATE_GUILD);
  const audit = await auditCommandRegistrations({ ...guardedOptions(fake, host, () => {}), allGuilds: true });
  const lines = [];
  const result = await cleanupCommandRegistrations({
    ...guardedOptions(fake, host, (line) => lines.push(line)), allGuilds: true, expectedDigest: audit.digest, confirm: true,
  });

  assert.equal(result.status, 'deleted');
  assert.deepEqual(fake.mutations().map((call) => `${call.method} ${call.route}`), [
    `DELETE ${commandsRoute()}/${ids.games}`,
    `DELETE ${guildRoute(CLEANUP_GUILD)}/${ids.cleanupGames}`,
    `DELETE ${guildRoute(OTHER_GUILD)}/${strayOther.id}`,
  ]);
  assert.ok(fake.calls.every((call) => call.method === 'GET' || !call.route.includes(PRIVATE_GUILD)));
  assert.deepEqual(fake.commandsIn(PRIVATE_GUILD), privateBefore, 'the private guild keeps every command, including the stray /help');
  assert.ok(fake.commandsIn('global').some((command) => command.id === ids.roll), 'a changed command is redeployed, not deleted');
  assert.ok(fake.commandsIn('global').some((command) => command.id === ids.casino));

  // The verification read happens after the last deletion and finds nothing left.
  const lastDelete = fake.calls.findLastIndex((call) => call.method === 'DELETE');
  const verifyReads = fake.calls.slice(lastDelete + 1).map((call) => call.route);
  assert.deepEqual(verifyReads, [commandsRoute(), guildRoute(PRIVATE_GUILD), guildRoute(CLEANUP_GUILD), guildRoute(OTHER_GUILD)]);
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(result.residue, []);
  assert.equal(result.after.counts.extra, 1, 'only the private stray remains, reported but untouched');
  assert.match(lines.at(-1), /^\[COMMAND_CLEANUP\] result deleted deleted=3\/3 remaining=0 residue=0 digest [a-f0-9]{64}$/u);
});

test('guild cleanup is refused when no private deployment plan or no protected list is loaded', async (t) => {
  const host = createPrivateHost(t);
  const { fake, ids } = createDriftedDiscord(host, { joinedGuildIds: [PRIVATE_GUILD, CLEANUP_GUILD] });
  // The same Discord state seen without the private extension: the private guild looks foreign.
  const noPrivatePlan = { ...guardedOptions(fake, createExtensionHost([]), () => {}), allGuilds: true };
  const lines = [];
  const audit = await auditCommandRegistrations({ ...noPrivatePlan, report: (line) => lines.push(line) });
  assert.ok(lines.some((line) => line.includes('no private deployment plan is loaded')));
  for (const confirm of [false, true]) {
    await assert.rejects(
      cleanupCommandRegistrations({ ...noPrivatePlan, expectedDigest: audit.digest, confirm }),
      (error) => error.code === 'COMMAND_CLEANUP_REFUSED' && error.message.includes('private guilds cannot be protected'),
    );
  }
  assert.deepEqual(fake.mutations(), []);

  // With the plan but without a protected list, no guild command is deleted either.
  const unprotected = productionOptions(fake, host, () => {});
  const unprotectedAudit = await auditCommandRegistrations(unprotected);
  for (const confirm of [false, true]) {
    await assert.rejects(
      cleanupCommandRegistrations({ ...unprotected, expectedDigest: unprotectedAudit.digest, confirm }),
      (error) => error.code === 'COMMAND_CLEANUP_REFUSED'
        && error.message.includes('XIAOJI_PROTECTED_GUILD_IDS is not set') && error.message.includes('--public-only'),
    );
  }
  assert.deepEqual(fake.mutations(), []);

  // --public-only reads and cleans the global scope only.
  const publicOnly = { ...productionOptions(fake, host, () => {}), publicOnly: true };
  const globalAudit = await auditCommandRegistrations(publicOnly);
  assert.deepEqual(globalAudit.diff.scopes.map((scope) => scope.scope), ['global']);
  const result = await cleanupCommandRegistrations({ ...publicOnly, expectedDigest: globalAudit.digest, confirm: true });
  assert.equal(result.status, 'deleted');
  assert.deepEqual(fake.mutations().map((call) => call.route), [`${commandsRoute()}/${ids.games}`]);
});

test('cleanup stops at the first failed deletion and still reads back what is left', async (t) => {
  const host = createPrivateHost(t);
  const { fake, ids } = createDriftedDiscord(host, {
    deleteBehavior: (generated) => ({ [`${commandsRoute()}/${generated.games}`]: 'fail' }),
  });
  const audit = await auditCommandRegistrations(guardedOptions(fake, host, () => {}));
  const result = await cleanupCommandRegistrations({
    ...guardedOptions(fake, host, () => {}), expectedDigest: audit.digest, confirm: true,
  });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.failure.status, 500);
  assert.deepEqual(fake.mutations().map((call) => call.route), [`${commandsRoute()}/${ids.games}`], 'no deletion after a failure');
  const lastDelete = fake.calls.findLastIndex((call) => call.method === 'DELETE');
  assert.ok(fake.calls.slice(lastDelete + 1).some((call) => call.route === commandsRoute()), 'verification read after the failure');
  assert.deepEqual(result.remaining.map((target) => target.commandId), [ids.games, ids.cleanupGames]);
});

test('the verification read reports a command Discord did not actually delete', async (t) => {
  const host = createPrivateHost(t);
  // Discord answers 204 but the command is still there.
  const { fake, ids } = createDriftedDiscord(host, {
    deleteBehavior: (generated) => ({ [`${guildRoute(CLEANUP_GUILD)}/${generated.cleanupGames}`]: 'ignore' }),
  });
  // runDeploymentCli replaces report with its own log.
  const dependencies = guardedOptions(fake, host, () => {});
  const audit = await auditCommandRegistrations({ ...dependencies, report: () => {} });
  const lines = [];
  const exitCode = await runDeploymentCli(['--cleanup', audit.digest, '--yes'], { log: (line) => lines.push(line), dependencies });
  assert.equal(exitCode, 1);
  assert.ok(lines.includes(`[COMMAND_CLEANUP] still registered extra scope=guild:${CLEANUP_GUILD} kind=cleanup-guild name="/games" id=${ids.cleanupGames}`));
  assert.match(lines.at(-1), /^\[COMMAND_CLEANUP\] result incomplete deleted=2\/2 remaining=1 residue=1 digest [a-f0-9]{64}$/u);
});

test('test-control audit and cleanup stay inside the trusted test guild of the test application', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
  const identity = { applicationId: IDS.app, botUserId: IDS.app, channelGuildId: IDS.guild };
  const stray = asRegistered(byName('work'), { applicationId: IDS.app, guildId: IDS.guild });
  const fake = createFakeDiscord({
    applicationId: IDS.app,
    identity,
    guilds: { [IDS.guild]: [asRegistered(byName('ping'), { applicationId: IDS.app, guildId: IDS.guild }), stray] },
    joinedGuildIds: [IDS.guild, IDS.otherGuild],
  });
  const options = {
    token: TOKEN, clientId: IDS.app, rest: fake.rest, testControl: true, testControlPolicy: policy, protectedGuildIds: null, report: () => {},
  };
  const testCommands = guildRoute(IDS.guild, IDS.app);

  const audit = await auditCommandRegistrations(options);
  assert.equal(audit.testControl, true);
  assert.deepEqual(audit.diff.scopes.map((scope) => [scope.scope, scope.kind]), [[`guild:${IDS.guild}`, 'test-guild']]);
  const commandReads = fake.calls.filter((call) => call.route.includes('/commands'));
  assert.deepEqual(commandReads.map((call) => call.route), [testCommands]);
  assert.ok(fake.calls.every((call) => call.method === 'GET'
    && call.route !== commandsRoute(IDS.app) && call.route !== '/users/@me/guilds'));

  for (const forbidden of [{ allGuilds: true }, { publicOnly: true }, { cleanupGuildIds: [IDS.otherGuild] }, { extensionHost: createExtensionHost([]) }]) {
    await assert.rejects(auditCommandRegistrations({ ...options, ...forbidden }), /test-control|public-only/iu);
  }
  await assert.rejects(auditCommandRegistrations({ ...options, testControl: false }), /explicit test-control action/u);
  await assert.rejects(auditCommandRegistrations({ ...options, testControlPolicy: null }), /trusted launcher/u);

  // A protected test guild is never a cleanup target either.
  const guarded = await auditCommandRegistrations({ ...options, protectedGuildIds: IDS.guild });
  assert.deepEqual(guarded.cleanupCandidates, []);
  assert.equal(guarded.diff.items.find((item) => item.commandId === stray.id).protected, true);

  const preview = await cleanupCommandRegistrations({ ...options, expectedDigest: audit.digest });
  assert.equal(preview.status, 'dry-run');
  assert.deepEqual(fake.mutations(), []);
  const deleted = await cleanupCommandRegistrations({ ...options, expectedDigest: audit.digest, confirm: true });
  assert.equal(deleted.status, 'deleted');
  assert.deepEqual(fake.mutations().map((call) => `${call.method} ${call.route}`), [`DELETE ${testCommands}/${stray.id}`]);

  // A formal bot token is refused before any command list is read.
  const formal = createFakeDiscord({ applicationId: IDS.app, identity: { ...identity, applicationId: IDS.formal } });
  await assert.rejects(
    auditCommandRegistrations({ ...options, rest: formal.rest }),
    (error) => error.code === 'TEST_FORMAL_APP_FORBIDDEN',
  );
  assert.ok(formal.calls.every((call) => !call.route.includes('/commands')));
});

test('a private guild the extension forgot is never deleted with --all-guilds when it is protected', async (t) => {
  const host = createPrivateHost(t);
  const forgotten = asRegistered({ name: 'forgotten-tool', description: '私有群自己的指令', type: 1 }, { guildId: UNDECLARED_PRIVATE_GUILD });
  const strayOther = asRegistered({ name: 'old-tool', description: '舊工具', type: 1 }, { guildId: OTHER_GUILD });
  const { fake, ids } = createDriftedDiscord(host, {
    guilds: { [UNDECLARED_PRIVATE_GUILD]: [forgotten], [OTHER_GUILD]: [strayOther] },
    joinedGuildIds: [PRIVATE_GUILD, CLEANUP_GUILD, OTHER_GUILD, UNDECLARED_PRIVATE_GUILD],
  });
  // Without the list the forgotten guild looks like any other guild: its command is a target.
  const unprotected = await auditCommandRegistrations({ ...productionOptions(fake, host, () => {}), allGuilds: true });
  assert.ok(unprotected.cleanupCandidates.some((item) => item.commandId === forgotten.id));

  const options = {
    ...productionOptions(fake, host, () => {}), allGuilds: true, protectedGuildIds: ` ${PRIVATE_GUILD}, ${UNDECLARED_PRIVATE_GUILD} ,`,
  };
  const auditLines = [];
  const audit = await auditCommandRegistrations({ ...options, report: (line) => auditLines.push(line) });
  assert.ok(auditLines.includes(`[COMMAND_AUDIT] scope guild:${UNDECLARED_PRIVATE_GUILD} kind=other-guild expected=0 registered=1 protected=true`));
  assert.ok(auditLines.includes(
    `[COMMAND_AUDIT] extra scope=guild:${UNDECLARED_PRIVATE_GUILD} kind=other-guild name="/forgotten-tool" id=${forgotten.id} protected=true`,
  ));
  assert.ok(auditLines.some((line) => line.startsWith(`[COMMAND_AUDIT] scope guild:${PRIVATE_GUILD} kind=private-guild `)
    && line.endsWith(' protected=true')));
  assert.equal(auditLines.some((line) => line.includes('warning')), false, 'every planned private guild is protected');
  assert.deepEqual(audit.cleanupCandidates.map((item) => item.commandId), [ids.games, ids.cleanupGames, strayOther.id]);
  assert.notEqual(audit.digest, unprotected.digest);

  const lines = [];
  const result = await cleanupCommandRegistrations({
    ...options, report: (line) => lines.push(line), expectedDigest: audit.digest, confirm: true,
  });
  assert.equal(result.status, 'deleted');
  assert.deepEqual(fake.mutations().map((call) => `${call.method} ${call.route}`), [
    `DELETE ${commandsRoute()}/${ids.games}`,
    `DELETE ${guildRoute(CLEANUP_GUILD)}/${ids.cleanupGames}`,
    `DELETE ${guildRoute(OTHER_GUILD)}/${strayOther.id}`,
  ]);
  assert.ok(fake.calls.every((call) => call.method === 'GET' || !call.route.includes(UNDECLARED_PRIVATE_GUILD)));
  assert.deepEqual(fake.commandsIn(UNDECLARED_PRIVATE_GUILD), [forgotten]);
  assert.deepEqual(result.protectedSkipped.map((item) => item.commandId), [ids.privateHelp, forgotten.id]);
  assert.ok(lines.includes(
    `[COMMAND_CLEANUP] skip extra scope=guild:${UNDECLARED_PRIVATE_GUILD} kind=other-guild name="/forgotten-tool" id=${forgotten.id} protected=true`,
  ));
  assert.equal(lines.some((line) => line.includes('reminder')), false);
});

test('the protected list warns about gaps, binds the digest and is suggested when unset', async (t) => {
  const host = createPrivateHost(t);
  const { fake } = createDriftedDiscord(host);
  // Only the cleanup guild is listed: the planned private guild is unprotected, and a
  // normal deployment would refuse to clear the protected cleanup guild.
  const lines = [];
  const partial = { ...productionOptions(fake, host, (line) => lines.push(line)), protectedGuildIds: [CLEANUP_GUILD] };
  const audit = await auditCommandRegistrations(partial);
  assert.ok(lines.includes(
    `[COMMAND_AUDIT] warning: private guild guild:${PRIVATE_GUILD} of the deployment plan is not in XIAOJI_PROTECTED_GUILD_IDS.`,
  ));
  assert.ok(lines.includes(`[COMMAND_AUDIT] warning: guild:${CLEANUP_GUILD} (cleanup-guild) is protected; npm run deploy will refuse `
    + 'to run until you remove it from deployment.cleanupGuildIds.'));
  assert.equal(lines.at(-1), `[COMMAND_AUDIT] digest ${audit.digest}`);
  assert.equal(audit.cleanupCandidates.some((item) => item.scope === `guild:${CLEANUP_GUILD}`), false);

  // Dropping the list after the audit would widen the deletion set, so the digest stops matching.
  const widened = await cleanupCommandRegistrations({ ...partial, protectedGuildIds: null, expectedDigest: audit.digest, confirm: true });
  assert.equal(widened.status, 'digest-mismatch');
  assert.deepEqual(fake.mutations(), []);

  // A list that covers no scope that was read leaves the difference list and digest as if unset.
  const scopes = [{ kind: 'public-global', expected: GLOBAL, actual: fake.commandsIn('global') }];
  assert.equal(
    computeRegistryDiff({ applicationId: APP, scopes, protectedGuildIds: [SECOND_OTHER_GUILD] }).digest,
    computeRegistryDiff({ applicationId: APP, scopes }).digest,
  );

  // Unset: nothing is marked, the audit and every cleanup run (preview or --yes) remind,
  // and the guild leftover is refused rather than deleted.
  const reminder = 'reminder: XIAOJI_PROTECTED_GUILD_IDS is not set, so --cleanup deletes no guild command.';
  const unsetLines = [];
  const unset = productionOptions(fake, host, (line) => unsetLines.push(line));
  const unsetAudit = await auditCommandRegistrations(unset);
  assert.equal(unsetLines.some((line) => line.includes('protected=true')), false);
  assert.ok(unsetLines.some((line) => line.startsWith(`[COMMAND_AUDIT] ${reminder}`)));
  assert.equal(unsetLines.at(-1), `[COMMAND_AUDIT] digest ${unsetAudit.digest}`);
  for (const confirm of [false, true]) {
    unsetLines.length = 0;
    await assert.rejects(
      cleanupCommandRegistrations({ ...unset, expectedDigest: unsetAudit.digest, confirm }),
      (error) => error.code === 'COMMAND_CLEANUP_REFUSED',
    );
    assert.ok(unsetLines.some((line) => line.startsWith(`[COMMAND_CLEANUP] ${reminder}`)), `confirm=${confirm}`);
  }
  assert.deepEqual(fake.mutations(), []);
  // A global-only run reads no guild, so there is nothing to remind about.
  const globalLines = [];
  await auditCommandRegistrations({ ...unset, publicOnly: true, report: (line) => globalLines.push(line) });
  assert.equal(globalLines.some((line) => line.includes('reminder')), false);

  const setLines = [];
  const set = { ...productionOptions(fake, host, (line) => setLines.push(line)), protectedGuildIds: PRIVATE_GUILD };
  const setAudit = await auditCommandRegistrations(set);
  await cleanupCommandRegistrations({ ...set, expectedDigest: setAudit.digest });
  assert.equal(setLines.some((line) => line.includes('reminder')), false);
  assert.deepEqual(fake.mutations(), []);
});

test('XIAOJI_PROTECTED_GUILD_IDS is parsed strictly, before any request, and read from the environment', async (t) => {
  assert.equal(parseProtectedGuildIds(undefined), null);
  assert.equal(parseProtectedGuildIds(''), null);
  assert.equal(parseProtectedGuildIds(' , '), null);
  assert.deepEqual(parseProtectedGuildIds(` ${OTHER_GUILD},${PRIVATE_GUILD} ,${OTHER_GUILD}`), [PRIVATE_GUILD, OTHER_GUILD]);
  assert.deepEqual(parseProtectedGuildIds(new Set([PRIVATE_GUILD])), [PRIVATE_GUILD]);
  for (const invalid of ['abc', `${PRIVATE_GUILD};${OTHER_GUILD}`, '12345', `${PRIVATE_GUILD},<#1>`, 42]) {
    assert.throws(
      () => parseProtectedGuildIds(invalid),
      (error) => error.code === 'COMMAND_REGISTRY_PROTECTED_INVALID' && !error.message.includes(String(invalid)),
    );
  }

  const host = createPrivateHost(t);
  const { fake } = createDriftedDiscord(host);
  const invalid = { ...productionOptions(fake, host, () => {}), protectedGuildIds: 'not-a-guild-id' };
  await assert.rejects(auditCommandRegistrations(invalid), (error) => error.code === 'COMMAND_REGISTRY_PROTECTED_INVALID');
  await assert.rejects(
    cleanupCommandRegistrations({ ...invalid, expectedDigest: 'a'.repeat(64), confirm: true }),
    (error) => error.code === 'COMMAND_REGISTRY_PROTECTED_INVALID',
  );
  assert.deepEqual(fake.calls, []);

  // Without the option, audit and cleanup read the environment variable.
  const previous = process.env.XIAOJI_PROTECTED_GUILD_IDS;
  process.env.XIAOJI_PROTECTED_GUILD_IDS = PRIVATE_GUILD;
  try {
    const fromEnvironment = productionOptions(fake, host, () => {});
    delete fromEnvironment.protectedGuildIds;
    const audit = await auditCommandRegistrations(fromEnvironment);
    assert.equal(audit.diff.scopes.find((scope) => scope.scope === `guild:${PRIVATE_GUILD}`).protected, true);
  } finally {
    if (previous === undefined) delete process.env.XIAOJI_PROTECTED_GUILD_IDS;
    else process.env.XIAOJI_PROTECTED_GUILD_IDS = previous;
  }
});

test('every deletion target is checked again: private guilds, foreign test guilds and unplanned guilds are refused', () => {
  const target = (scopeKind, guildId, overrides = {}) => ({
    type: 'extra', scope: guildId ? `guild:${guildId}` : 'global', scopeKind, name: 'old', commandType: 1, commandId: nextId(), ...overrides,
  });
  const scopeOf = (item) => ({ scope: item.scope, kind: item.scopeKind, guildId: item.scope === 'global' ? null : item.scope.slice(6) });
  const refused = (item, context, scope = scopeOf(item)) => assert.throws(
    () => assertCleanupTarget(item, scope, context),
    (error) => error.code === 'COMMAND_CLEANUP_REFUSED',
  );
  const production = {
    testControlPolicy: null,
    privatePlanLoaded: true,
    privateGuildIds: new Set([PRIVATE_GUILD]),
    protectedConfigured: true,
    protectedGuildIds: new Set([UNDECLARED_PRIVATE_GUILD]),
  };
  assert.doesNotThrow(() => assertCleanupTarget(target('public-global', null), scopeOf(target('public-global', null)), production));
  const otherTarget = target('other-guild', OTHER_GUILD);
  assert.doesNotThrow(() => assertCleanupTarget(otherTarget, scopeOf(otherTarget), production));
  refused(target('private-guild', PRIVATE_GUILD), production);
  refused(target('other-guild', PRIVATE_GUILD), production);
  refused(target('cleanup-guild', PRIVATE_GUILD), production);
  // The protected list wins over the plan and over the scope kind.
  refused(target('other-guild', UNDECLARED_PRIVATE_GUILD), production);
  refused(target('cleanup-guild', UNDECLARED_PRIVATE_GUILD), production);
  refused(target('test-guild', OTHER_GUILD), production);
  refused(target('other-guild', OTHER_GUILD, { type: 'changed' }), production);
  refused(target('other-guild', OTHER_GUILD, { commandId: '../1' }), production);
  refused(otherTarget, production, { ...scopeOf(otherTarget), kind: 'private-guild' });
  refused(otherTarget, production, null);
  refused(otherTarget, { ...production, privatePlanLoaded: false });
  // Without a protected list no guild command is deleted, but global commands still are.
  const unlisted = { ...production, protectedConfigured: false, protectedGuildIds: new Set() };
  refused(otherTarget, unlisted);
  refused(target('cleanup-guild', CLEANUP_GUILD), unlisted);
  assert.doesNotThrow(() => assertCleanupTarget(target('public-global', null), scopeOf(target('public-global', null)), unlisted));

  const policy = { allowsGuild: (guildId) => guildId === IDS.guild };
  const testControl = {
    testControlPolicy: policy, privatePlanLoaded: false, privateGuildIds: new Set(), protectedConfigured: true, protectedGuildIds: new Set(),
  };
  const testTarget = target('test-guild', IDS.guild);
  assert.doesNotThrow(() => assertCleanupTarget(testTarget, scopeOf(testTarget), testControl));
  refused(testTarget, { ...testControl, protectedGuildIds: new Set([IDS.guild]) });
  refused(target('test-guild', IDS.otherGuild), testControl);
  refused(target('public-global', null), testControl);
  refused(target('other-guild', IDS.guild), testControl);
});

test('normal deployment reads back and only reports differences', async (t) => {
  const host = createPrivateHost(t);
  const fake = createFakeDiscord({ guilds: { [CLEANUP_GUILD]: [asRegistered(byName('ping'), { guildId: CLEANUP_GUILD })] } });
  const lines = [];
  // The plan clears the cleanup guild, which needs the protected list.
  const result = await deployCommands(guardedOptions(fake, host, (line) => lines.push(line)));
  assert.equal(result.readback.ok, true);
  // The owner variable is pinned unset here. The public core has no owner-only command, so there is nothing to warn about.
  const readbackLines = lines.filter((line) => !line.startsWith('[OWNER_COMMANDS]'));
  assert.equal(lines.length - readbackLines.length, 0);
  assert.equal(readbackLines.length, 1);
  assert.match(readbackLines[0], /^\[COMMAND_READBACK\] Discord matches the deployment in 3 scope\(s\)\. digest [a-f0-9]{64}$/u);
  const lastPut = fake.calls.findLastIndex((call) => call.method === 'PUT');
  assert.deepEqual(fake.calls.slice(lastPut + 1).map((call) => call.route), [commandsRoute(), guildRoute(PRIVATE_GUILD), guildRoute(CLEANUP_GUILD)]);

  // Discord silently dropped /ping: report it, change nothing.
  const dropping = createFakeDiscord({ putFilter: (body, key) => (key === 'global' ? body.filter((command) => command.name !== 'ping') : body) });
  const driftLines = [];
  const drift = await deployCommands(guardedOptions(dropping, host, (line) => driftLines.push(line)));
  assert.equal(drift.readback.ok, false);
  assert.deepEqual(drift.readback.diff.items.map((item) => [item.type, item.name]), [['missing', 'ping']]);
  assert.ok(driftLines.includes('[COMMAND_READBACK] missing scope=global kind=public-global name="/ping"'));
  assert.deepEqual(dropping.mutations().map((call) => call.method), ['PUT', 'PUT'], 'no correction after the readback');

  // A failed readback never fails the deployment. (No cleanup guild here: the existing
  // legacy cleanup must read before it writes and would stop earlier. This plan clears no
  // guild, so it also runs without the protected list.)
  const unreadable = createFakeDiscord();
  unreadable.rest.get = async () => { throw httpError(503); };
  const failedLines = [];
  const noCleanupHost = createPrivateHost(t, { cleanupGuildIds: [] });
  const failed = await deployCommands(productionOptions(unreadable, noCleanupHost, (line) => failedLines.push(line)));
  assert.equal(failed.readback.ok, false);
  assert.equal(failed.readback.error, 'COMMAND_REGISTRY_READ_FAILED');
  assert.deepEqual(unreadable.mutations().map((call) => call.route), [commandsRoute(), guildRoute(PRIVATE_GUILD)]);
  assert.deepEqual(
    failedLines.filter((line) => !line.startsWith('[OWNER_COMMANDS]')),
    ['[COMMAND_READBACK] Readback failed (COMMAND_REGISTRY_READ_FAILED); the deployment itself was sent.'],
  );
});

test('normal deployment refuses to clear a protected guild before any Discord request', async (t) => {
  const host = createPrivateHost(t);
  const withCleanupLeftover = () => createFakeDiscord({
    guilds: { [CLEANUP_GUILD]: [asRegistered(byName('ping'), { guildId: CLEANUP_GUILD })] },
  });
  const refusedFor = (label) => (error) => error.code === 'COMMAND_CLEANUP_REFUSED'
    && error.message.includes(label)
    && error.message.includes('deployment.cleanupGuildIds');

  // A protected legacy cleanup guild: refused in a dry run and in a real run, before any call.
  for (const dryRun of [true, false]) {
    const fake = withCleanupLeftover();
    await assert.rejects(
      deployCommands({ ...guardedOptions(fake, host, () => {}), dryRun, protectedGuildIds: `${PRIVATE_GUILD},${CLEANUP_GUILD}` }),
      (error) => refusedFor(`guild:${CLEANUP_GUILD} (cleanup-guild)`)(error) && !error.message.includes(`guild:${PRIVATE_GUILD}`),
    );
    assert.equal(fake.calls.length, 0, `dryRun=${dryRun}`);
  }

  // The legacy-private fallback would PUT an empty list to a deployment guild without commands.
  const targetsOnly = createExtensionHost([{ id: 'synthetic-targets', deployment: { guildIds: [PRIVATE_GUILD] } }]);
  for (const dryRun of [true, false]) {
    const fake = createFakeDiscord();
    await assert.rejects(
      deployCommands({ ...guardedOptions(fake, targetsOnly, () => {}), dryRun }),
      refusedFor(`guild:${PRIVATE_GUILD} (private-guild)`),
    );
    assert.equal(fake.calls.length, 0, `dryRun=${dryRun}`);
  }

  // AUTO_DEPLOY_COMMANDS calls deployCommands({ extensionHost }), which reads the list from
  // the environment.
  const previous = process.env.XIAOJI_PROTECTED_GUILD_IDS;
  process.env.XIAOJI_PROTECTED_GUILD_IDS = CLEANUP_GUILD;
  try {
    const fake = withCleanupLeftover();
    const fromEnvironment = productionOptions(fake, host, () => {});
    delete fromEnvironment.protectedGuildIds;
    await assert.rejects(deployCommands(fromEnvironment), refusedFor(`guild:${CLEANUP_GUILD} (cleanup-guild)`));
    assert.equal(fake.calls.length, 0);
  } finally {
    if (previous === undefined) delete process.env.XIAOJI_PROTECTED_GUILD_IDS;
    else process.env.XIAOJI_PROTECTED_GUILD_IDS = previous;
  }

  // With a list that protects only guilds keeping their commands, clearing is deployed as before.
  const fake = withCleanupLeftover();
  const result = await deployCommands(guardedOptions(fake, host, () => {}));
  assert.equal(result.cleanupCount, 1);
  assert.deepEqual(fake.mutations().map((call) => `${call.method} ${call.route}`), [
    `PUT ${commandsRoute()}`, `PUT ${guildRoute(PRIVATE_GUILD)}`, `PUT ${guildRoute(CLEANUP_GUILD)}`,
  ]);
  assert.deepEqual(fake.commandsIn(CLEANUP_GUILD), []);
  const fallback = await deployCommands({
    ...productionOptions(createFakeDiscord(), targetsOnly, () => {}), dryRun: true, protectedGuildIds: OTHER_GUILD,
  });
  assert.deepEqual(fallback.plan.map((operation) => [operation.kind, operation.guildId ?? null, operation.body.length]), [
    ['public-global', null, GLOBAL.length],
    ['private-guild', PRIVATE_GUILD, 0],
  ]);
});

test('without a protected list a deployment that would clear any guild is refused', async (t) => {
  const refusedUnset = (label) => (error) => error.code === 'COMMAND_CLEANUP_REFUSED'
    && error.message.includes(label)
    && error.message.includes('XIAOJI_PROTECTED_GUILD_IDS is not set')
    && error.message.includes('list every private guild');
  const cleanupHost = createPrivateHost(t);
  const targetsOnly = createExtensionHost([{ id: 'synthetic-targets', deployment: { guildIds: [PRIVATE_GUILD] } }]);
  // A legacy cleanup and the empty-list fallback, in dry and real runs, with no REST call.
  for (const [host, label] of [
    [cleanupHost, `guild:${CLEANUP_GUILD} (cleanup-guild)`],
    [targetsOnly, `guild:${PRIVATE_GUILD} (private-guild)`],
  ]) {
    for (const dryRun of [true, false]) {
      const fake = createFakeDiscord({ guilds: { [CLEANUP_GUILD]: [asRegistered(byName('ping'), { guildId: CLEANUP_GUILD })] } });
      await assert.rejects(deployCommands({ ...productionOptions(fake, host, () => {}), dryRun }), refusedUnset(label));
      assert.equal(fake.calls.length, 0, `${label} dryRun=${dryRun}`);
    }
  }

  // AUTO_DEPLOY_COMMANDS with no list in the environment refuses the same way.
  const previous = process.env.XIAOJI_PROTECTED_GUILD_IDS;
  delete process.env.XIAOJI_PROTECTED_GUILD_IDS;
  try {
    const fake = createFakeDiscord();
    const fromEnvironment = productionOptions(fake, cleanupHost, () => {});
    delete fromEnvironment.protectedGuildIds;
    await assert.rejects(deployCommands(fromEnvironment), refusedUnset(`guild:${CLEANUP_GUILD} (cleanup-guild)`));
    assert.equal(fake.calls.length, 0);
  } finally {
    if (previous !== undefined) process.env.XIAOJI_PROTECTED_GUILD_IDS = previous;
  }

  // The audit warns about the same refusal.
  const lines = [];
  const { fake: drifted } = createDriftedDiscord(cleanupHost);
  await auditCommandRegistrations(productionOptions(drifted, cleanupHost, (line) => lines.push(line)));
  assert.ok(lines.includes(`[COMMAND_AUDIT] warning: npm run deploy will refuse to clear guild:${CLEANUP_GUILD} (cleanup-guild) `
    + 'until XIAOJI_PROTECTED_GUILD_IDS is set (list every private guild).'));

  // A plan that clears no guild deploys as before without the list.
  const keepHost = createPrivateHost(t, { cleanupGuildIds: [] });
  const fake = createFakeDiscord();
  await deployCommands(productionOptions(fake, keepHost, () => {}));
  assert.deepEqual(fake.mutations().map((call) => `${call.method} ${call.route}`), [
    `PUT ${commandsRoute()}`, `PUT ${guildRoute(PRIVATE_GUILD)}`,
  ]);
  const globalOnly = createFakeDiscord();
  await deployCommands({ ...productionOptions(globalOnly, keepHost, () => {}), publicOnly: true });
  assert.deepEqual(globalOnly.mutations().map((call) => call.route), [commandsRoute()]);
});

test('a malformed protected list fails every normal deployment before any Discord request', async (t) => {
  const keepHost = createPrivateHost(t, { cleanupGuildIds: [] });
  for (const extra of [{ dryRun: true }, { dryRun: false }, { publicOnly: true }]) {
    const fake = createFakeDiscord();
    await assert.rejects(
      deployCommands({ ...productionOptions(fake, keepHost, () => {}), ...extra, protectedGuildIds: `${PRIVATE_GUILD},not-a-guild-id` }),
      (error) => error.code === 'COMMAND_REGISTRY_PROTECTED_INVALID' && !error.message.includes('not-a-guild-id'),
    );
    assert.equal(fake.calls.length, 0, JSON.stringify(extra));
  }

  // AUTO_DEPLOY_COMMANDS reads the same list from the environment and stops startup.
  const previous = process.env.XIAOJI_PROTECTED_GUILD_IDS;
  process.env.XIAOJI_PROTECTED_GUILD_IDS = 'not-a-guild-id';
  try {
    const fake = createFakeDiscord();
    const fromEnvironment = productionOptions(fake, keepHost, () => {});
    delete fromEnvironment.protectedGuildIds;
    await assert.rejects(deployCommands(fromEnvironment), (error) => error.code === 'COMMAND_REGISTRY_PROTECTED_INVALID');
    assert.equal(fake.calls.length, 0);
  } finally {
    if (previous === undefined) delete process.env.XIAOJI_PROTECTED_GUILD_IDS;
    else process.env.XIAOJI_PROTECTED_GUILD_IDS = previous;
  }
});

test('a test-control deployment reports each test guild with the number of commands it received', async (t) => {
  const fixture = createFixture({
    XIAOJI_TEST_ALLOWED_GUILD_IDS: `${IDS.guild},${IDS.otherGuild}`,
    XIAOJI_TEST_ALLOWED_COMMANDS: 'ping,help',
  });
  t.after(() => fixture.cleanup());
  const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
  const fake = createFakeDiscord({
    applicationId: IDS.app,
    identity: { applicationId: IDS.app, botUserId: IDS.app, channelGuildId: IDS.guild },
  });
  const dependencies = { token: TOKEN, clientId: IDS.app, rest: fake.rest, testControlPolicy: policy, protectedGuildIds: null };
  const lines = [];
  assert.equal(await runDeploymentCli(['--test-control'], { log: (line) => lines.push(line), dependencies }), 0);
  assert.equal(lines.at(-1), `Test commands deployed to 2 test guild(s): guild:${IDS.guild}=2, guild:${IDS.otherGuild}=2.`);
  assert.deepEqual(fake.mutations().map((call) => `${call.method} ${call.route}`), [
    `PUT ${guildRoute(IDS.guild, IDS.app)}`, `PUT ${guildRoute(IDS.otherGuild, IDS.app)}`,
  ]);
  assert.equal(fake.commandsIn(IDS.guild).length, 2);
  assert.equal(lines.some((line) => line.startsWith('Slash commands deployed')), false);

  const planned = [];
  await runDeploymentCli(['--test-control'], { log: (line) => planned.push(line), dependencies: { ...dependencies, dryRun: true } });
  assert.deepEqual(planned, [`Test commands planned (dry run) to 2 test guild(s): guild:${IDS.guild}=2, guild:${IDS.otherGuild}=2.`]);
});

// Loaded with --require before src/index.js: no socket can open and login is a probe. The
// catalog is drifted and the data preflight, which needs a fully initialized data
// directory, is skipped so that startup reaches AUTO_DEPLOY_COMMANDS.
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
REST.prototype.request = async function blockedRequest() {
  process.stdout.write('XIAOJI_TEST_REST_REQUEST\n');
  throw new Error('XIAOJI_TEST_NETWORK_BLOCKED');
};
const { Client } = require(require.resolve('discord.js', { paths: [root] }));
Client.prototype.login = async function blockedLogin() {
  process.stdout.write('XIAOJI_TEST_LOGIN\n');
  throw new Error('XIAOJI_TEST_LOGIN_BLOCKED');
};
const catalogPath = require.resolve(path.join(root, 'website', 'commandCatalog.js'));
const catalog = require(catalogPath);
require.cache[catalogPath].exports = Object.freeze({
  ...catalog,
  COMMAND_CATALOG: Object.freeze(catalog.COMMAND_CATALOG.map((entry) => (entry.name === 'ping'
    ? Object.freeze({ ...entry, description: 'drifted description' })
    : entry))),
});
const preflightPath = require.resolve(path.join(root, 'src', 'platform', 'runtimeDataPreflight.js'));
const preflight = require(preflightPath);
require.cache[preflightPath].exports = { ...preflight, preflightRuntimeData: async () => {} };
`;
const STARTUP_PARENT_KEYS = new Set([
  'COMSPEC', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR',
]);

test('with AUTO_DEPLOY_COMMANDS a drifted catalog stops startup with a non-zero exit before login', (t) => {
  const projectRoot = path.join(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-auto-deploy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // An empty working directory, so dotenv finds no .env file.
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd);
  const preload = path.join(root, 'preload.js');
  fs.writeFileSync(preload, STARTUP_PRELOAD);
  const parentEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => STARTUP_PARENT_KEYS.has(key.toUpperCase())));
  const start = (autoDeploy) => spawnSync(process.execPath, ['--require', preload, path.join(projectRoot, 'src', 'index.js')], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    windowsHide: true,
    env: {
      ...parentEnv,
      XIAOJI_STARTUP_TEST_ROOT: projectRoot,
      AUTO_DEPLOY_COMMANDS: autoDeploy,
      DISCORD_TOKEN: TOKEN,
      DISCORD_CLIENT_ID: APP,
      BOT_OWNER_ID: OTHER_GUILD,
    },
  });

  const stopped = start('true');
  assert.equal(stopped.signal, null, 'startup must end by itself');
  assert.equal(stopped.status, 1);
  assert.match(stopped.stdout, /AUTO_DEPLOY_COMMANDS 已啟用/u);
  assert.match(stopped.stderr, /Command catalog validation failed:\n- \/ping description differs/u);
  assert.equal(stopped.stdout.includes('XIAOJI_TEST_LOGIN'), false, 'no login attempt');
  assert.equal(stopped.stdout.includes('XIAOJI_TEST_REST_REQUEST'), false, 'no Discord request');
  assert.equal(`${stopped.stdout}${stopped.stderr}`.includes(TOKEN), false);
  assert.deepEqual(fs.readdirSync(cwd), []);

  // Control: without AUTO_DEPLOY_COMMANDS the drift only warns and startup reaches the
  // login probe, which shows that the probe above would have caught a login.
  const reached = start('false');
  assert.equal(reached.signal, null);
  assert.equal(reached.status, 1);
  assert.match(reached.stderr, /\[COMMAND_CATALOG\] \/ping description differs/u);
  assert.equal(reached.stdout.includes('XIAOJI_TEST_LOGIN'), true);
  assert.equal(reached.stdout.includes('XIAOJI_TEST_REST_REQUEST'), false);
});

test('audit, cleanup and readback output never contains credentials', async (t) => {
  const host = createPrivateHost(t);
  for (const token of [TOKEN, TOKEN_SHAPED]) {
    const { fake } = createDriftedDiscord(host);
    const lines = [];
    const report = (line) => lines.push(line);
    const options = { ...guardedOptions(fake, host, report), token };
    const audit = await auditCommandRegistrations(options);
    await cleanupCommandRegistrations({ ...options, expectedDigest: audit.digest });
    await cleanupCommandRegistrations({ ...options, expectedDigest: audit.digest, confirm: true });
    await deployCommands(options);
    assert.ok(lines.length > 10);
    assert.ok(lines.every((line) => !line.includes(token)));
  }

  // A Discord error that carries the token in its message and request stays out of the output.
  const leaking = createFakeDiscord();
  leaking.rest.get = async () => {
    throw Object.assign(new Error(`401 for Bot ${TOKEN}`), { status: 401, requestBody: { headers: { Authorization: `Bot ${TOKEN}` } } });
  };
  const error = await auditCommandRegistrations({ ...productionOptions(leaking, host, () => {}) }).catch((caught) => caught);
  assert.equal(error.code, 'COMMAND_REGISTRY_READ_FAILED');
  assert.equal(error.message.includes(TOKEN), false);
  const printed = [];
  reportCliFailure(Object.assign(new Error(`failed with ${TOKEN} and ${TOKEN_SHAPED}`), {}), ['--audit'], {
    env: { DISCORD_TOKEN: TOKEN },
    logError: (line) => printed.push(String(line)),
  });
  assert.equal(printed.length, 1);
  assert.equal(printed[0].includes(TOKEN) || printed[0].includes(TOKEN_SHAPED), false);
  const safe = [];
  createSafeWriter((line) => safe.push(line), [TOKEN])(`x ${TOKEN} y ${TOKEN_SHAPED}`);
  assert.equal(safe[0].includes(TOKEN) || safe[0].includes(TOKEN_SHAPED), false);

  // A value pasted on the command line is never echoed in the usage error.
  assert.throws(() => parseDeploymentArgs(['--audit', TOKEN]), (caught) => !caught.message.includes(TOKEN));
});

test('command line keeps the old forms and validates the audit and cleanup options', async (t) => {
  assert.deepEqual(parseDeploymentArgs([]), { publicOnly: false });
  assert.deepEqual(parseDeploymentArgs(['--public-only']), { publicOnly: true });
  assert.deepEqual(parseDeploymentArgs(['--test-control']), { publicOnly: false, testControl: true });
  assert.deepEqual(parseDeploymentArgs(['--audit']), { action: 'audit', publicOnly: false, testControl: false, allGuilds: false });
  assert.deepEqual(parseDeploymentArgs(['--audit', '--all-guilds']), { action: 'audit', publicOnly: false, testControl: false, allGuilds: true });
  assert.deepEqual(parseDeploymentArgs(['--test-control', '--audit']), { action: 'audit', publicOnly: false, testControl: true, allGuilds: false });
  const digest = 'A'.repeat(64);
  assert.deepEqual(parseDeploymentArgs(['--cleanup', digest, '--yes']), {
    action: 'cleanup', publicOnly: false, testControl: false, allGuilds: false, expectedDigest: 'a'.repeat(64), confirm: true,
  });
  for (const invalid of [
    ['--cleanup'],
    ['--cleanup', 'abc'],
    ['--cleanup', '--yes'],
    ['--audit', '--yes'],
    ['--audit', '--cleanup', digest],
    ['--audit', '--audit'],
    ['--audit', '--all-guilds', '--public-only'],
    ['--audit', '--all-guilds', '--test-control'],
    ['--audit', '--public-only', '--test-control'],
    ['--yes'],
    ['--all-guilds'],
    ['--public-only', '--test-control'],
    ['--audit', '--unknown'],
  ]) {
    assert.throws(() => parseDeploymentArgs(invalid), (error) => error.code === 'DEPLOY_USAGE', invalid.join(' '));
  }

  const host = createPrivateHost(t);
  const { fake } = createDriftedDiscord(host);
  // runDeploymentCli replaces report with its own log.
  const dependencies = guardedOptions(fake, host, () => {});
  const lines = [];
  const log = (line) => lines.push(line);
  assert.equal(await runDeploymentCli(['--audit'], { log, dependencies }), 0);
  const auditDigest = lines.at(-1).split(' ').at(-1);
  assert.equal(await runDeploymentCli(['--cleanup', 'f'.repeat(64)], { log, dependencies }), 1);
  assert.equal(await runDeploymentCli(['--cleanup', auditDigest], { log, dependencies }), 0);
  assert.deepEqual(fake.mutations(), []);
  assert.equal(await runDeploymentCli(['--cleanup', auditDigest, '--yes'], { log, dependencies }), 0);
  assert.equal(fake.mutations().length, 2);
});
