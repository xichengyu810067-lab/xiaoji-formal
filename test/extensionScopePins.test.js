'use strict';

// Pins for the private-extension scope and the guard order.
//
// The refactor batches that follow move code around the extension seams. These tests pin
// what must not move:
//   1. Deployment scope: a private command reaches only the guilds its own command group
//      declares, and a guild is cleared only after its commands were read back.
//   2. Guard order: an extension guard that handles an interaction stops the interactionCreate
//      hooks and every public branch after it.
//   3. workRole hooks: the hook names, payloads and default results.
//
// Every Discord call goes to an in-memory fake and every database is a synthetic SQLite file
// inside a temporary directory. No test opens a network connection or starts the bot. The
// synthetic extension lives in test/fixtures/synthetic-extension/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-extension-pins-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');
process.env.BOT_OWNER_ID = 'owner-user';

const { buildDeploymentPlan, deployCommands } = require('../deploy-commands');
const { createExtensionHost } = require('../src/extensions/extensionHost');
const interactionCreate = require('../src/events/interactionCreate');
const { loadCommandData, loadPrivateCommandGroups } = require('../src/loadCommands');
const commandCatalog = require('../website/commandCatalog');
const {
  getCoinDatabasePath,
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const workService = require('../src/services/workService');
const logger = require('../src/utils/logger');
const { GROUPS, GUILDS, createSyntheticExtension } = require('./fixtures/synthetic-extension');

const APP = '123456789012345678';
const FOREIGN_APP = '223456789012345678';
const TOKEN = 'synthetic-pins-token-0123456789';
const OWNED_GUILDS = [GUILDS.first, GUILDS.second, GUILDS.third, GUILDS.fourth];
// The global commands. A whole owner-only command goes to the owner guild instead (test/ownerGuildDeployment.test.js).
const OWNER_NAMES = new Set(commandCatalog.COMMAND_CATALOG.filter((entry) => entry.audience === 'owner').map((entry) => entry.name));
const PUBLIC_NAMES = loadCommandData(undefined, { scope: 'public' }).map((entry) => entry.name)
  .filter((name) => !OWNER_NAMES.has(name));

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

const clone = (value) => JSON.parse(JSON.stringify(value));

// Runs the callback with the logger silenced, so a test that drives real event code stays
// quiet. Returns what the callback returned and what it logged.
async function withQuietLogs(run) {
  const lines = [];
  const original = { info: logger.info, warn: logger.warn, error: logger.error };
  logger.info = (message) => { lines.push(['info', String(message)]); };
  logger.warn = (message) => { lines.push(['warn', String(message)]); };
  logger.error = (message) => { lines.push(['error', String(message)]); };
  try {
    return { value: await run(), lines };
  } finally {
    Object.assign(logger, original);
  }
}

const command = (name) => ({ name, description: `synthetic ${name}`, type: 1 });
const globalRoute = `/applications/${APP}/commands`;
const guildRoute = (guildId) => `/applications/${APP}/guilds/${guildId}/commands`;

function summarize(plan) {
  return plan.map((operation) => ({
    kind: operation.kind,
    guildId: operation.guildId ?? null,
    route: operation.route,
    commands: operation.body.map((entry) => entry.name),
    requiresReadback: operation.requiresReadback === true,
  }));
}

// A Discord REST fake: GET lists what is registered on a route, PUT replaces it. Every call is
// recorded so the order of reads and writes can be asserted.
function createFakeRest({ guilds = {} } = {}) {
  const lists = new Map([['global', []]]);
  for (const [guildId, commands] of Object.entries(guilds)) lists.set(guildId, commands.map(clone));
  const calls = [];
  let counter = 800000000000000000n;
  const nextId = () => String(counter += 1n);
  const keyOf = (route) => route.match(/\/guilds\/(\d+)\/commands$/u)?.[1] ?? 'global';
  const rest = {
    async get(route) {
      calls.push({ method: 'GET', route });
      return clone(lists.get(keyOf(route)) || []);
    },
    async put(route, { body }) {
      const key = keyOf(route);
      calls.push({ method: 'PUT', route, commands: body.map((entry) => entry.name) });
      lists.set(key, body.map((entry) => ({
        ...clone(entry),
        id: nextId(),
        application_id: APP,
        version: nextId(),
        ...(key === 'global' ? {} : { guild_id: key }),
      })));
      return clone(lists.get(key));
    },
  };
  return { rest, calls };
}

// A command left registered in a guild by an older deployment.
function leftover(guildId, applicationId = APP) {
  return {
    id: '810000000000000001',
    application_id: applicationId,
    version: '810000000000000002',
    guild_id: guildId,
    type: 1,
    name: 'synthetic-leftover',
    description: 'Synthetic leftover command',
  };
}

function productionOptions(fake, host, extra = {}) {
  return {
    token: TOKEN,
    clientId: APP,
    rest: fake.rest,
    extensionHost: host,
    testControlPolicy: null,
    protectedGuildIds: OWNED_GUILDS,
    // null pins "not configured", whatever the developer's environment holds.
    ownerGuildId: null,
    report: () => {},
    ...extra,
  };
}

// ---- 1. Deployment scope ---------------------------------------------------------------------

test('the plan sends each private command only to the guilds its own group declares', () => {
  const groups = [
    { commandGroupId: 'synthetic:alpha', guildIds: [GUILDS.first, GUILDS.second], commands: [command('synthetic-alpha')] },
    { commandGroupId: 'synthetic:beta', guildIds: [GUILDS.second, GUILDS.third], commands: [command('synthetic-beta')] },
    { commandGroupId: 'synthetic:gamma', guildIds: [GUILDS.third, GUILDS.fourth], commands: [command('synthetic-gamma')] },
  ];
  const plan = buildDeploymentPlan({
    clientId: APP,
    publicCommands: [command('ping')],
    privateCommands: groups.flatMap((group) => group.commands),
    privateCommandGroups: groups,
    // The extension-level scope also lists a guild no group declares, and cleanup targets
    // that include guilds the groups own.
    deploymentTargets: [{
      extensionId: 'synthetic',
      guildIds: [...OWNED_GUILDS, GUILDS.outsider],
      cleanupGuildIds: [GUILDS.third, GUILDS.cleanup],
    }],
    cleanupGuildIds: [GUILDS.fourth, GUILDS.emptied],
  });

  assert.deepEqual(summarize(plan), [
    { kind: 'public-global', guildId: null, route: globalRoute, commands: ['ping'], requiresReadback: false },
    // Commands are unioned only inside a guild that two groups share.
    { kind: 'private-guild', guildId: GUILDS.first, route: guildRoute(GUILDS.first), commands: ['synthetic-alpha'], requiresReadback: false },
    { kind: 'private-guild', guildId: GUILDS.second, route: guildRoute(GUILDS.second), commands: ['synthetic-alpha', 'synthetic-beta'], requiresReadback: false },
    { kind: 'private-guild', guildId: GUILDS.third, route: guildRoute(GUILDS.third), commands: ['synthetic-beta', 'synthetic-gamma'], requiresReadback: false },
    { kind: 'private-guild', guildId: GUILDS.fourth, route: guildRoute(GUILDS.fourth), commands: ['synthetic-gamma'], requiresReadback: false },
    // Only guilds no group owns can be cleared, and each clearing waits for a readback.
    { kind: 'legacy-cleanup', guildId: GUILDS.emptied, route: guildRoute(GUILDS.emptied), commands: [], requiresReadback: true },
    { kind: 'legacy-cleanup', guildId: GUILDS.cleanup, route: guildRoute(GUILDS.cleanup), commands: [], requiresReadback: true },
  ]);
  // A guild no group declares gets nothing: not a command and not a clearing request.
  assert.equal(plan.some((operation) => operation.guildId === GUILDS.outsider), false);
});

test('two groups that share a guild may not register the same command there', () => {
  const twin = () => [command('synthetic-twin')];
  const plan = (privateCommandGroups) => buildDeploymentPlan({
    clientId: APP, publicCommands: [], privateCommandGroups, deploymentTargets: [],
  });

  assert.throws(() => plan([
    { commandGroupId: 'one', guildIds: [GUILDS.first, GUILDS.second], commands: twin() },
    { commandGroupId: 'two', guildIds: [GUILDS.second], commands: twin() },
  ]), /Multiple private command groups register \/synthetic-twin in guild 710000000000000002\./u);

  // The same name in groups that share no guild is fine: each guild still gets exactly one.
  assert.deepEqual(summarize(plan([
    { commandGroupId: 'one', guildIds: [GUILDS.first], commands: twin() },
    { commandGroupId: 'two', guildIds: [GUILDS.second], commands: twin() },
  ])).map((entry) => [entry.guildId, entry.commands]), [
    [null, []],
    [GUILDS.first, ['synthetic-twin']],
    [GUILDS.second, ['synthetic-twin']],
  ]);
});

test('without command groups every private command goes to each extension target guild', () => {
  const plan = buildDeploymentPlan({
    clientId: APP,
    publicCommands: [],
    privateCommands: [command('synthetic-one'), command('synthetic-two')],
    privateCommandGroups: [],
    deploymentTargets: [
      { extensionId: 'synthetic', guildIds: [GUILDS.first, GUILDS.second], cleanupGuildIds: [GUILDS.cleanup] },
      { extensionId: 'synthetic-other', guildIds: [GUILDS.second], cleanupGuildIds: [] },
    ],
  });

  assert.deepEqual(summarize(plan).map((entry) => [entry.kind, entry.guildId, entry.commands]), [
    ['public-global', null, []],
    ['private-guild', GUILDS.first, ['synthetic-one', 'synthetic-two']],
    ['private-guild', GUILDS.second, ['synthetic-one', 'synthetic-two']],
    ['legacy-cleanup', GUILDS.cleanup, []],
  ]);
});

test('a command group takes its guilds from itself, else from the extension, and [] means nowhere', () => {
  const host = createExtensionHost([createSyntheticExtension({
    groups: [
      { id: 'synthetic:explicit', directory: GROUPS[0].directory, guildIds: [GUILDS.second] },
      { id: 'synthetic:inherits', directory: GROUPS[1].directory },
      { id: 'synthetic:nowhere', directory: GROUPS[2].directory, guildIds: [] },
    ],
    deployment: { guildIds: [GUILDS.first], cleanupGuildIds: [GUILDS.cleanup] },
  })]);

  assert.deepEqual(host.getCommandDirectories().map((entry) => [entry.commandGroupId, entry.guildIds]), [
    ['synthetic:explicit', [GUILDS.second]],
    ['synthetic:inherits', [GUILDS.first]],
    ['synthetic:nowhere', []],
  ]);
  assert.deepEqual(host.getDeploymentTargets(), [{
    extensionId: 'synthetic-scope-pins',
    guildIds: [GUILDS.first, GUILDS.second],
    cleanupGuildIds: [GUILDS.cleanup],
  }]);
  assert.deepEqual(loadPrivateCommandGroups(host).map((group) => [group.commandGroupId, group.guildIds]), [
    ['synthetic:explicit', [GUILDS.second]],
    ['synthetic:inherits', [GUILDS.first]],
    ['synthetic:nowhere', []],
  ]);
});

test('the synthetic extension loads as three command groups with their own guild scopes', () => {
  const host = createExtensionHost([createSyntheticExtension()]);
  const groups = loadPrivateCommandGroups(host);

  assert.deepEqual(groups.map((group) => [group.commandGroupId, group.guildIds, group.commands.map((entry) => entry.name)]), [
    ['synthetic:alpha', [GUILDS.first, GUILDS.second], ['synthetic-alpha']],
    ['synthetic:beta', [GUILDS.second, GUILDS.third], ['synthetic-beta']],
    ['synthetic:gamma', [GUILDS.third, GUILDS.fourth], ['synthetic-gamma']],
  ]);
});

test('a real deployment reads the cleanup guilds first, then writes only declared and cleanup guilds', async () => {
  const host = createExtensionHost([createSyntheticExtension({
    deployment: {
      // The outsider is a target nobody owns; the third guild is owned and listed for cleanup.
      guildIds: [GUILDS.outsider],
      cleanupGuildIds: [GUILDS.third, GUILDS.cleanup, GUILDS.emptied],
    },
  })]);
  const fake = createFakeRest({ guilds: { [GUILDS.cleanup]: [leftover(GUILDS.cleanup)], [GUILDS.emptied]: [] } });

  const result = await deployCommands(productionOptions(fake, host));

  // Both cleanup guilds are read before the first write of the whole deployment.
  const firstWrite = fake.calls.findIndex((call) => call.method === 'PUT');
  assert.deepEqual(fake.calls.slice(0, firstWrite), [
    { method: 'GET', route: guildRoute(GUILDS.cleanup) },
    { method: 'GET', route: guildRoute(GUILDS.emptied) },
  ]);
  // The writes: public commands, each owned guild, then only the guild that still had commands.
  assert.deepEqual(fake.calls.filter((call) => call.method === 'PUT').map((call) => [call.route, call.commands]), [
    [globalRoute, PUBLIC_NAMES],
    [guildRoute(GUILDS.first), ['synthetic-alpha']],
    [guildRoute(GUILDS.second), ['synthetic-alpha', 'synthetic-beta']],
    [guildRoute(GUILDS.third), ['synthetic-beta', 'synthetic-gamma']],
    [guildRoute(GUILDS.fourth), ['synthetic-gamma']],
    [guildRoute(GUILDS.cleanup), []],
  ]);
  // After the last write the deployment only reads back, and never touches the outsider.
  const lastWrite = fake.calls.findLastIndex((call) => call.method === 'PUT');
  const readback = fake.calls.slice(lastWrite + 1);
  assert.equal(readback.every((call) => call.method === 'GET'), true);
  assert.deepEqual(readback.map((call) => call.route), [
    globalRoute, ...OWNED_GUILDS.map(guildRoute), guildRoute(GUILDS.cleanup), guildRoute(GUILDS.emptied),
  ]);
  assert.equal(fake.calls.some((call) => call.route === guildRoute(GUILDS.outsider)), false);
  assert.deepEqual(
    [result.privateCommandCount, result.privateGuildCount, result.cleanupCount],
    [3, 4, 2],
  );
});

test('a dry run plans the same deployment without any Discord call', async () => {
  const host = createExtensionHost([createSyntheticExtension({ deployment: { cleanupGuildIds: [GUILDS.cleanup] } })]);
  const fake = createFakeRest();

  const result = await deployCommands(productionOptions(fake, host, { dryRun: true }));

  assert.equal(fake.calls.length, 0);
  assert.deepEqual(summarize(result.plan).map((entry) => [entry.kind, entry.guildId, entry.commands, entry.requiresReadback]), [
    ['public-global', null, PUBLIC_NAMES, false],
    ['private-guild', GUILDS.first, ['synthetic-alpha'], false],
    ['private-guild', GUILDS.second, ['synthetic-alpha', 'synthetic-beta'], false],
    ['private-guild', GUILDS.third, ['synthetic-beta', 'synthetic-gamma'], false],
    ['private-guild', GUILDS.fourth, ['synthetic-gamma'], false],
    ['legacy-cleanup', GUILDS.cleanup, [], true],
  ]);
});

test('a guild that a command group owns is never cleared, even when it is listed for cleanup', async () => {
  const host = createExtensionHost([createSyntheticExtension({ deployment: { cleanupGuildIds: OWNED_GUILDS } })]);
  const fake = createFakeRest();

  // Without a protected list a deployment that clears any guild is refused, so passing null
  // also proves that this plan clears nothing.
  const result = await deployCommands(productionOptions(fake, host, {
    protectedGuildIds: null,
    cleanupGuildIds: [GUILDS.first, GUILDS.second],
  }));

  assert.equal(result.cleanupCount, 0);
  const writes = fake.calls.filter((call) => call.method === 'PUT');
  assert.deepEqual(writes.map((call) => call.route), [globalRoute, ...OWNED_GUILDS.map(guildRoute)]);
  assert.equal(writes.slice(1).every((call) => call.commands.length > 0), true);
  // With nothing to clear there is nothing to read first: the first call is the first write.
  assert.deepEqual(fake.calls[0], { method: 'PUT', route: globalRoute, commands: PUBLIC_NAMES });
});

test('a cleanup readback that is not this application\'s stops the deployment before any write', async () => {
  const host = createExtensionHost([createSyntheticExtension({ deployment: { cleanupGuildIds: [GUILDS.cleanup] } })]);
  const fake = createFakeRest({ guilds: { [GUILDS.cleanup]: [leftover(GUILDS.cleanup, FOREIGN_APP)] } });

  await assert.rejects(
    deployCommands(productionOptions(fake, host)),
    /Legacy cleanup readback does not belong to this bot in guild 710000000000000005\./u,
  );

  assert.deepEqual(fake.calls, [{ method: 'GET', route: guildRoute(GUILDS.cleanup) }]);
});

test('a Discord client that cannot read commands back is refused before any write', async () => {
  const host = createExtensionHost([createSyntheticExtension({ deployment: { cleanupGuildIds: [GUILDS.cleanup] } })]);
  const writes = [];
  const writeOnly = { put: async (route) => { writes.push(route); return []; } };

  await assert.rejects(
    deployCommands(productionOptions({ rest: writeOnly }, host)),
    /Legacy cleanup requires Discord command readback before mutation\./u,
  );

  assert.deepEqual(writes, []);
});

// ---- 2. Guard order --------------------------------------------------------------------------

const APPROVED_GUILD = '720000000000000001';
const PENDING_GUILD = '720000000000000002';

fs.writeFileSync(process.env.XIAOJI_AUDIT_DATA_PATH, `${JSON.stringify({
  [APPROVED_GUILD]: { status: 'approved' },
  [PENDING_GUILD]: { status: 'pending' },
}, null, 2)}\n`);
fs.writeFileSync(process.env.XIAOJI_INVITER_WHITELIST_PATH, '[]\n');

// One synthetic extension behind a client whose only command records that it ran. The trace
// lists, in order, everything the extension and the public command were asked to do.
function createGuardHarness({ guard = null, hookResults = {} } = {}) {
  const trace = [];
  const payloads = [];
  const extension = createSyntheticExtension({
    groups: [],
    guard,
    hookResults,
    record: (name, payload) => {
      trace.push(name);
      payloads.push({ name, payload });
    },
  });
  const client = {
    commands: new Map([['synthetic-alpha', {
      execute: async () => { trace.push('command.execute'); },
      autocomplete: async () => { trace.push('command.autocomplete'); },
    }]]),
    extensionHost: createExtensionHost([extension]),
  };
  return { trace, payloads, client };
}

// kind: 'command' | 'autocomplete' | 'button'. A real AutocompleteInteraction can only
// respond() with suggestions, so it has no reply().
function createInteraction({ kind, guildId, userId = 'stranger', client }) {
  const sent = { replies: [], responds: [] };
  const interaction = {
    client,
    guildId,
    channelId: 'room',
    user: { id: userId },
    commandName: kind === 'button' ? undefined : 'synthetic-alpha',
    customId: kind === 'button' ? 'poll:synthetic' : undefined,
    replied: false,
    deferred: false,
    responded: false,
    isAutocomplete: () => kind === 'autocomplete',
    isButton: () => kind === 'button',
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isChatInputCommand: () => kind === 'command',
    reply: async (payload) => { sent.replies.push(payload); },
    respond: async (choices) => { sent.responds.push(choices); },
  };
  return { interaction, sent };
}

const GUARDED_INTERACTIONS = Object.freeze([
  { label: 'a command in a guild recorded as pending', kind: 'command', guildId: PENDING_GUILD },
  { label: 'a command in a guild recorded as approved', kind: 'command', guildId: APPROVED_GUILD },
  { label: 'a command by the bot owner in a guild recorded as pending', kind: 'command', guildId: PENDING_GUILD, userId: 'owner-user' },
  { label: 'an autocomplete in a guild recorded as pending', kind: 'autocomplete', guildId: PENDING_GUILD },
  { label: 'an autocomplete in a guild recorded as approved', kind: 'autocomplete', guildId: APPROVED_GUILD },
  { label: 'a button in a guild recorded as pending', kind: 'button', guildId: PENDING_GUILD },
]);

test('a guard that handles the interaction stops the extension hooks and every public branch', async () => {
  for (const { label, kind, guildId, userId } of GUARDED_INTERACTIONS) {
    const harness = createGuardHarness({ guard: () => ({ handled: true }) });
    const { interaction, sent } = createInteraction({ kind, guildId, userId, client: harness.client });

    await withQuietLogs(() => interactionCreate.execute(interaction));

    // Only the guard ran: no interactionCreate hook, no command, no autocomplete.
    assert.deepEqual(harness.trace, ['guards.interaction'], label);
    // No public branch answered with a reply or a suggestion list, and no command ran.
    assert.deepEqual(sent, { replies: [], responds: [] }, label);
  }
});

test('without a handling guard the same interactions reach the hooks and the public branches, whatever the guild was recorded as', async () => {
  const run = async ({ kind, guildId, userId }) => {
    const harness = createGuardHarness({ guard: () => ({ handled: false }) });
    const { interaction, sent } = createInteraction({ kind, guildId, userId, client: harness.client });
    await withQuietLogs(() => interactionCreate.execute(interaction));
    return { trace: harness.trace, sent };
  };
  const passed = ['guards.interaction', 'interactionCreate'];

  // A command runs in a guild recorded as pending, as in one recorded as approved, for a stranger and for the
  // bot owner: no guild is held back, and nothing is answered in place of the command.
  for (const index of [0, 1, 2]) {
    const reached = await run(GUARDED_INTERACTIONS[index]);
    assert.deepEqual(reached.trace, [...passed, 'command.execute'], GUARDED_INTERACTIONS[index].label);
    assert.deepEqual(reached.sent, { replies: [], responds: [] }, GUARDED_INTERACTIONS[index].label);
  }
  for (const index of [3, 4]) {
    const reached = await run(GUARDED_INTERACTIONS[index]);
    assert.deepEqual(reached.trace, [...passed, 'command.autocomplete'], GUARDED_INTERACTIONS[index].label);
    assert.deepEqual(reached.sent, { replies: [], responds: [] }, GUARDED_INTERACTIONS[index].label);
  }
});

test('the guard runs before the interactionCreate hooks, and a handled hook stops every public branch too', async () => {
  const harness = createGuardHarness({
    guard: () => ({ handled: false }),
    hookResults: { interactionCreate: { handled: true } },
  });
  const { interaction, sent } = createInteraction({ kind: 'command', guildId: PENDING_GUILD, client: harness.client });

  await withQuietLogs(() => interactionCreate.execute(interaction));

  assert.deepEqual(harness.trace, ['guards.interaction', 'interactionCreate']);
  assert.deepEqual(sent, { replies: [], responds: [] });
});

test('the guard receives the interaction and the command name, and the hook receives the interaction', async () => {
  const harness = createGuardHarness({
    guard: () => ({ handled: false }),
    hookResults: { interactionCreate: { handled: true } },
  });
  const command = createInteraction({ kind: 'command', guildId: APPROVED_GUILD, client: harness.client });
  await withQuietLogs(() => interactionCreate.execute(command.interaction));
  const button = createInteraction({ kind: 'button', guildId: APPROVED_GUILD, client: harness.client });
  await withQuietLogs(() => interactionCreate.execute(button.interaction));

  const [guardCommand, hookCommand, guardButton] = harness.payloads;
  assert.deepEqual(Object.keys(guardCommand.payload).sort(), ['commandName', 'interaction']);
  assert.equal(guardCommand.payload.interaction, command.interaction);
  assert.equal(guardCommand.payload.commandName, 'synthetic-alpha');
  assert.deepEqual(Object.keys(hookCommand.payload), ['interaction']);
  assert.equal(hookCommand.payload.interaction, command.interaction);
  assert.equal(guardButton.name, 'guards.interaction');
  assert.equal(guardButton.payload.interaction, button.interaction);
  assert.equal(guardButton.payload.commandName, null);
});

test('the host stops at the first guard that handles, and hooks stop at a handled result only when asked', async () => {
  const order = [];
  const handled = { handled: true, reason: 'synthetic scope' };
  const hosted = (id, guardResult, hookResult) => createSyntheticExtension({
    id,
    groups: [],
    guard: () => { order.push(`${id}.guard`); return guardResult; },
    hookResults: { interactionCreate: () => { order.push(`${id}.hook`); return hookResult; } },
  });
  const host = createExtensionHost([
    hosted('one', { handled: false }, undefined),
    hosted('two', handled, { handled: true }),
    hosted('three', { handled: true }, { handled: true }),
  ]);

  assert.equal(await host.guardInteraction({ interaction: {}, commandName: null }), handled);
  assert.deepEqual(order, ['one.guard', 'two.guard']);

  order.length = 0;
  await host.runHook('interactionCreate', {}, { stopOnHandled: true });
  assert.deepEqual(order, ['one.hook', 'two.hook']);
  order.length = 0;
  await host.runHook('interactionCreate', {});
  assert.deepEqual(order, ['one.hook', 'two.hook', 'three.hook']);

  assert.deepEqual(await createExtensionHost([]).guardInteraction({ interaction: {}, commandName: null }), { handled: false });
});

// ---- 3. workRole hooks -----------------------------------------------------------------------
//
// Six call sites ask the extension to change job roles: /work role-sync (three hooks),
// /work cancel, the primary-cycle settlement and the legacy payroll. Each test records the hook
// name and payload the extension receives, and the reply or result the core builds from what
// the extension returns, including the defaults used when it returns nothing.

const WORK_GUILD_ID = '730000000000000001';
const OTHER_GUILD_ID = '730000000000000002';
const ADMIN_ID = '730000000000000010';
const BOT_ID = '730000000000000099';
const USER_IDS = Object.freeze({
  primary: '730000000000000011',
  legacy: '730000000000000012',
  idle: '730000000000000013',
});

const workCommand = require('../src/commands/work');

function createMember(id) {
  return { id, toString: () => `<@${id}>` };
}

// A guild whose member list holds exactly the given user IDs.
function createGuild(memberIds = []) {
  const members = new Map(memberIds.map((id) => [id, createMember(id)]));
  return {
    id: WORK_GUILD_ID,
    members: {
      me: { id: BOT_ID, permissions: { has: () => true } },
      fetch: async (userId) => members.get(userId) ?? null,
    },
    memberOf: (userId) => members.get(userId),
  };
}

// An extension host whose workRole hooks record every call; hookResults decides what they return.
function createWorkHarness({ hookResults = {}, guild = createGuild() } = {}) {
  const calls = [];
  const extension = createSyntheticExtension({
    groups: [],
    hookResults,
    record: (name, payload) => calls.push({ hook: name, payload }),
  });
  const client = {
    extensionHost: createExtensionHost([extension]),
    guilds: { fetch: async (guildId) => (guildId === guild.id ? guild : null) },
  };
  // Replaces live objects in a recorded payload with labels so it compares as plain data.
  const snapshot = (labels = new Map()) => {
    const known = new Map([[client, 'client'], [guild, 'guild'], ...labels]);
    for (const [label, id] of Object.entries(USER_IDS)) {
      const member = guild.memberOf(id);
      if (member) known.set(member, `member:${label}`);
    }
    const walk = (value) => {
      if (known.has(value)) return known.get(value);
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
      }
      return value;
    };
    return calls.map((call) => ({ hook: call.hook, payload: walk(call.payload) }));
  };
  return { calls, client, guild, snapshot };
}

// A /work subcommand run by a server administrator. Replies are collected in order.
function createWorkInteraction({ subcommand, client, guild, guildId = WORK_GUILD_ID, userId = ADMIN_ID, user = null }) {
  const replies = [];
  const interaction = {
    client,
    guild,
    guildId,
    channelId: 'room',
    commandName: 'work',
    user: { id: userId },
    memberPermissions: { has: () => true },
    deferred: false,
    replied: false,
    inGuild: () => true,
    options: { getSubcommand: () => subcommand, getUser: () => user },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (payload) => { replies.push(payload); },
    reply: async (payload) => { replies.push(payload); },
  };
  return { interaction, replies };
}

test('/work role-sync without a user asks the extension to sync every job role', async () => {
  // No extension answers: the default summary is shown and nothing else.
  const bare = createWorkHarness();
  bare.client.extensionHost = createExtensionHost([]);
  const first = createWorkInteraction({ subcommand: 'role-sync', client: bare.client, guild: bare.guild });
  await workCommand.execute(first.interaction);
  assert.deepEqual(first.replies, ['工作身分組同步完成：0/0']);

  // The extension answers with a summary: total, synced, cleaned and at most ten warnings.
  const warnings = Array.from({ length: 12 }, (_, index) => `warning ${index + 1}`);
  const answered = createWorkHarness({
    hookResults: { 'workRole.syncAllJobRoles': { total: 3, synced: 2, cleaned: 1, warnings } },
  });
  const second = createWorkInteraction({ subcommand: 'role-sync', client: answered.client, guild: answered.guild });
  await workCommand.execute(second.interaction);
  assert.deepEqual(answered.snapshot(), [{ hook: 'workRole.syncAllJobRoles', payload: { guild: 'guild' } }]);
  assert.equal(answered.calls[0].payload.guild, answered.guild);
  assert.deepEqual(second.replies, [[
    '工作身分組同步完成：2/3',
    '已清理結束週期角色：1',
    '**身分組提醒**',
    ...warnings.slice(0, 10).map((warning) => `• ${warning}`),
  ].join('\n')]);
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

// Selects the next primary job for each user and lets the scheduler activate it, the way
// production does. Returns the active cycle ID of every user.
async function activatePrimaryJobs(clock, userIds) {
  clock.at('2026-03-02T01:00:00.000Z');
  for (const userId of userIds) {
    const selected = await workService.startJob(WORK_GUILD_ID, userId, '服務生', 2);
    assert.equal(selected.state, 'pending_legacy');
  }
  clock.at('2026-03-02T14:00:00.000Z');
  const activation = (await workService.processDueJobs(null)).activations;
  assert.deepEqual(activation, { checked: userIds.length, activated: userIds.length });
  const rows = await withCoinDatabase((api) => api.all('SELECT user_id, next_cycle_id FROM coin_primary_jobs_global'));
  return new Map(rows.map((row) => [row.user_id, row.next_cycle_id]));
}

// Mirrors the pre-v22 guild-scoped job row, which the product can no longer create.
async function insertLegacyJob(userId, { startAt = '2026-03-01T01:00:00.000Z', payAt = '2026-03-03T14:00:00.000Z' } = {}) {
  return withCoinTransaction((api) => {
    api.run(
      `INSERT INTO coin_jobs (
        guild_id, user_id, job_name, job_role_id, daily_salary, work_days, total_salary,
        status, is_paid, start_at, pay_at, last_contribution_at, today_task_count,
        today_completed_task_count, no_work_available_today, payroll_status, created_at, updated_at
      ) VALUES (?, ?, '服務生', NULL, 0, 2, 0, 'active', 0, ?, ?, NULL, 0, 0, 0, 'pending', ?, ?)`,
      [WORK_GUILD_ID, userId, startAt, payAt, startAt, startAt]
    );
    return Number(api.get('SELECT last_insert_rowid() AS id').id);
  });
}

const syntheticUser = (id) => ({ id, username: `synthetic-${id.slice(-2)}` });

// Runs /work role-sync for one user against a host and returns what the extension saw and what
// the administrator read.
async function runRoleSync({ harness, userId, guildId = WORK_GUILD_ID }) {
  const { interaction, replies } = createWorkInteraction({
    subcommand: 'role-sync', client: harness.client, guild: harness.guild, guildId, user: syntheticUser(userId),
  });
  await workCommand.execute(interaction);
  return replies;
}

test('/work role-sync for a user asks for the source-guild job roles with their ids, and keeps the defaults', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  await openSyntheticDatabase();
  const legacyJobId = await insertLegacyJob(USER_IDS.legacy);
  const cycleIds = await activatePrimaryJobs(clock, [USER_IDS.primary]);
  clock.at('2026-03-03T01:00:00.000Z');
  const cycleId = cycleIds.get(USER_IDS.primary);
  assert.ok(cycleId);
  const guild = createGuild([USER_IDS.primary, USER_IDS.legacy]);
  const done = (userId) => `synthetic-${userId.slice(-2)} 的職業身分組同步檢查完成。`;

  // The extension sees one hook per source-guild job, with the payload the core builds.
  const answering = createWorkHarness({ guild });
  const legacyReplies = await runRoleSync({ harness: answering, userId: USER_IDS.legacy });
  const primaryReplies = await runRoleSync({ harness: answering, userId: USER_IDS.primary });
  assert.deepEqual(answering.snapshot(), [
    {
      hook: 'workRole.syncJobRoleForMember',
      payload: {
        member: 'member:legacy',
        jobName: '服務生',
        options: { jobId: legacyJobId, sourceGuildId: WORK_GUILD_ID, triggerGuildId: WORK_GUILD_ID },
      },
    },
    {
      hook: 'workRole.syncPrimaryJobRoleForMember',
      payload: {
        member: 'member:primary',
        jobName: '服務生',
        options: { cycleId, sourceGuildId: WORK_GUILD_ID },
      },
    },
  ]);
  // Nobody returned anything, so both replies are built from the default result.
  assert.deepEqual(legacyReplies, [[done(USER_IDS.legacy), '原群職業：服務生'].join('\n')]);
  assert.deepEqual(primaryReplies, [[done(USER_IDS.primary), '全域主職：服務生；僅來源群可核對角色同步。'].join('\n')]);

  // Without any extension the replies are the same, because the same default applies.
  const bare = createWorkHarness({ guild });
  bare.client.extensionHost = createExtensionHost([]);
  assert.deepEqual(await runRoleSync({ harness: bare, userId: USER_IDS.legacy }), legacyReplies);
  assert.deepEqual(await runRoleSync({ harness: bare, userId: USER_IDS.primary }), primaryReplies);

  // The warnings of every answer are listed after the summary.
  const warning = createWorkHarness({
    guild,
    hookResults: {
      'workRole.syncJobRoleForMember': { ok: false, warnings: ['legacy warning'] },
      'workRole.syncPrimaryJobRoleForMember': { ok: true, warnings: ['primary warning'] },
    },
  });
  assert.deepEqual(await runRoleSync({ harness: warning, userId: USER_IDS.legacy }),
    [[done(USER_IDS.legacy), '原群職業：服務生', '**身分組提醒**', '• legacy warning'].join('\n')]);
  assert.deepEqual(await runRoleSync({ harness: warning, userId: USER_IDS.primary }),
    [[done(USER_IDS.primary), '全域主職：服務生；僅來源群可核對角色同步。', '**身分組提醒**', '• primary warning'].join('\n')]);
});

test('/work role-sync never asks the extension about another guild\'s jobs, a missing member or a user without work', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  await openSyntheticDatabase();
  await insertLegacyJob(USER_IDS.legacy);
  await activatePrimaryJobs(clock, [USER_IDS.primary]);
  clock.at('2026-03-03T01:00:00.000Z');
  const guild = createGuild([USER_IDS.primary, USER_IDS.legacy, USER_IDS.idle]);
  const harness = createWorkHarness({ guild });

  // Run from a guild that is not the jobs' source guild: the role side effect stays home. A
  // legacy job belongs to its own guild only; the global primary job is listed but not synced.
  const elsewhere = await runRoleSync({ harness, userId: USER_IDS.legacy, guildId: OTHER_GUILD_ID });
  assert.deepEqual(elsewhere, ['synthetic-12 目前沒有進行中的工作。']);
  const primaryElsewhere = await runRoleSync({ harness, userId: USER_IDS.primary, guildId: OTHER_GUILD_ID });
  // A primary job chosen in another server is not named here: it counts as no work at all.
  assert.equal(primaryElsewhere.length, 1);
  assert.match(primaryElsewhere[0], /目前沒有進行中的工作。$/u);
  assert.doesNotMatch(primaryElsewhere[0], /服務生|全域主職/u);
  // A user without active work, and a user who is not in the guild.
  assert.deepEqual(await runRoleSync({ harness, userId: USER_IDS.idle }), ['synthetic-13 目前沒有進行中的工作。']);
  const absent = '730000000000000014';
  assert.deepEqual(await runRoleSync({ harness, userId: absent }), ['找不到 synthetic-14 的伺服器成員資料。']);

  assert.deepEqual(harness.calls, []);
});

// Resigning is not offered, so /work cancel never reaches workRole.removeJobRolesForMember. The hook stays part of
// the extension contract (docs/EXTENSION_CONTRACT.md); an extension that exports it is simply not asked by this command.
test('/work cancel only explains that resigning is not offered; no work-role hook runs', async () => {
  const harness = createWorkHarness({
    guild: createGuild([USER_IDS.primary]),
    hookResults: { 'workRole.removeJobRolesForMember': { ok: false, warnings: ['never read'] } },
  });
  const { interaction, replies } = createWorkInteraction({
    subcommand: 'cancel', client: harness.client, guild: harness.guild, userId: USER_IDS.primary,
  });

  await workCommand.execute(interaction);

  assert.deepEqual(replies, [{ content: '目前不開放辭職。已開始的工作會在選定的天數期滿時自動結算薪水並結束。', ephemeral: true }]);
  assert.deepEqual(harness.calls, []);
  await assert.rejects(workService.cancelJob(), (error) => error.code === 'WORK_CUTOVER_CANCEL_REVIEW');
});

test('the primary-cycle cleanup asks for clearPrimaryJobRoleForMember with the cycle, user and source guild', async () => {
  const identity = { cycleId: 'synthetic-cycle-1', userId: USER_IDS.primary, sourceGuildId: WORK_GUILD_ID };
  const expectedPayload = { client: 'client', ...identity };

  // Without a client there is nobody to ask.
  assert.deepEqual(await workService.runPrimaryRoleCleanupAfterCommit(null, identity), { skipped: true });

  // The hook receives the client and the identity. Nothing returned means { skipped: true }.
  const quiet = createWorkHarness();
  assert.deepEqual(await workService.runPrimaryRoleCleanupAfterCommit(quiet.client, identity), { skipped: true });
  assert.deepEqual(quiet.snapshot(), [{ hook: 'workRole.clearPrimaryJobRoleForMember', payload: expectedPayload }]);
  assert.equal(quiet.calls[0].payload.client, quiet.client);

  // What the extension returns is passed on unchanged.
  const answer = { ok: false, warnings: ['cleanup needs a look'] };
  const answering = createWorkHarness({ hookResults: { 'workRole.clearPrimaryJobRoleForMember': answer } });
  assert.equal(await workService.runPrimaryRoleCleanupAfterCommit(answering.client, identity), answer);

  // A caller may inject how the hook is run: it gets the name and payload, the first defined
  // result wins, and a falsy winner falls back to { skipped: true }.
  const seen = [];
  const stub = { synthetic: 'client' };
  const inject = (results) => async (name, payload) => { seen.push([name, payload]); return results; };
  assert.deepEqual(await workService.runPrimaryRoleCleanupAfterCommit(stub, identity, {
    runHook: inject([{ result: undefined }, { result: { ok: true } }, { result: { ok: false } }]),
  }), { ok: true });
  assert.deepEqual(await workService.runPrimaryRoleCleanupAfterCommit(stub, identity, {
    runHook: inject([{ result: null }, { result: { ok: true } }]),
  }), { skipped: true });
  assert.deepEqual(await workService.runPrimaryRoleCleanupAfterCommit(stub, identity, { runHook: inject([]) }), { skipped: true });
  assert.deepEqual(seen.map(([name]) => name), Array(3).fill('workRole.clearPrimaryJobRoleForMember'));
  assert.deepEqual(seen[0][1], { client: stub, ...identity });
});

const byUserId = (left, right) => String(left.payload.userId).localeCompare(String(right.payload.userId));

test('the primary-cycle settlement asks the extension after the commit and survives a failing extension', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  await openSyntheticDatabase();
  const users = ['730000000000000021', '730000000000000022', '730000000000000023'];
  const cycleIds = await activatePrimaryJobs(clock, users);
  const statusWhenAsked = new Map();
  const harness = createWorkHarness({
    hookResults: {
      'workRole.clearPrimaryJobRoleForMember': async (payload) => {
        const cycle = await withCoinDatabase((api) => api.get(
          'SELECT status FROM coin_primary_job_cycles WHERE cycle_id = ?', [payload.cycleId]
        ));
        statusWhenAsked.set(payload.userId, cycle.status);
        if (payload.userId === users[1]) return { ok: false, warnings: ['cleanup needs a look'] };
        if (payload.userId === users[2]) throw new Error('synthetic extension failure');
        return undefined;
      },
    },
  });

  clock.at('2026-03-04T14:00:00.000Z');
  const { value: settlement, lines } = await withQuietLogs(() => workService.processDueJobs(harness.client));

  // Every cycle is settled; the extension's complaint and its crash only count as cleanup failures.
  assert.deepEqual(settlement.primaryCycles, { checked: 3, settled: 3, failed: 0, roleCleanupFailed: 2 });
  assert.deepEqual(harness.snapshot().sort(byUserId), users.map((userId) => ({
    hook: 'workRole.clearPrimaryJobRoleForMember',
    payload: { client: 'client', cycleId: cycleIds.get(userId), userId, sourceGuildId: WORK_GUILD_ID },
  })));
  // When the extension is asked the settlement is already committed.
  assert.deepEqual([...statusWhenAsked.entries()].sort(), users.map((userId) => [userId, 'settled']));
  const cycles = await withCoinDatabase((api) => api.all('SELECT status FROM coin_primary_job_cycles'));
  assert.deepEqual(cycles.map((cycle) => cycle.status), ['settled', 'settled', 'settled']);
  assert.equal(lines.filter(([level, message]) => level === 'warn' && message.includes('cycle=')).length, 2);
});

test('the legacy payroll asks the extension to remove the job role after paying, and survives a failing one', async (t) => {
  const clock = startClock(t, '2026-03-01T01:00:00.000Z');
  await openSyntheticDatabase();
  const users = { paid: '730000000000000031', failing: '730000000000000032', absent: '730000000000000033' };
  const jobIds = {};
  for (const [label, userId] of Object.entries(users)) jobIds[label] = await insertLegacyJob(userId);
  clock.at('2026-03-02T04:00:00.000Z');
  const captured = await withQuietLogs(() => workService.captureLegacyJobBatch());
  assert.deepEqual(captured.value, { users: 3, snapshots: 3, nextUserId: null });
  // The third user left the guild: the payroll still runs and nobody is asked about a role.
  const guild = createGuild([users.paid, users.failing]);
  const harness = createWorkHarness({
    guild,
    hookResults: {
      'workRole.removeJobRoleForMember': (payload) => {
        if (payload.member.id === users.failing) throw new Error('synthetic extension failure');
        return undefined;
      },
    },
  });

  clock.at('2026-03-03T14:00:00.000Z');
  const { value: payroll, lines } = await withQuietLogs(() => workService.processDueJobs(harness.client));

  assert.deepEqual([payroll.processed, payroll.success, payroll.fail], [3, 3, 0]);
  const labels = new Map([
    [guild.memberOf(users.paid), 'member:paid'],
    [guild.memberOf(users.failing), 'member:failing'],
  ]);
  assert.deepEqual(harness.snapshot(labels).sort((left, right) => left.payload.member.localeCompare(right.payload.member)), [
    { hook: 'workRole.removeJobRoleForMember', payload: { member: 'member:failing', jobName: '服務生' } },
    { hook: 'workRole.removeJobRoleForMember', payload: { member: 'member:paid', jobName: '服務生' } },
  ]);
  assert.equal(harness.calls[0].payload.member, guild.memberOf(harness.calls[0].payload.member.id));
  // A failing extension is logged as a warning and never undoes a payroll.
  assert.deepEqual(lines.filter(([level]) => level === 'warn').map(([, message]) => message),
    [`發薪後移除工作身分組失敗：job=${jobIds.failing}`]);
  const history = await withCoinDatabase((api) => api.all('SELECT job_id FROM coin_payroll_history ORDER BY job_id'));
  assert.deepEqual(history.map((row) => row.job_id), Object.values(jobIds));
});
