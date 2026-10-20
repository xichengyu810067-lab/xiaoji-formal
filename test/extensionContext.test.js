'use strict';

// The private extension context (src/platform/extensionContext.js) and where the extension host opens it.
// Every extension here is synthetic: its files are written into a temporary folder together with a real
// assembly contract and manifest, so loadConfiguredPrivateExtension verifies it the way it verifies the
// private extension. Nothing here opens a network connection or starts the bot.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-extension-context-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');
process.env.BOT_OWNER_ID = '720000000000000099';

const {
  createExtensionHost,
  loadConfiguredPrivateExtension,
  validateExtension,
} = require('../src/extensions/extensionHost');
const {
  claimExtensionContextRunner,
  currentExtensionContext,
  interactionTokenDigest,
  runOutsideExtensionContext,
} = require('../src/platform/extensionContext');
const { writeAssemblyManifest } = require('../src/extensions/assemblyManifest');
const { loadCommands } = require('../src/loadCommands');
const interactionCreate = require('../src/events/interactionCreate');
const { resetCoinDatabaseForTests } = require('../src/services/coinDatabase');
const logger = require('../src/utils/logger');

const CONTEXT_MODULE = require.resolve('../src/platform/extensionContext');
const PROJECT_ROOT = path.join(__dirname, '..');
const GUILDS = Object.freeze({
  first: '720000000000000001',
  second: '720000000000000002',
  third: '720000000000000003',
});
const PENDING_GUILD = '720000000000000004';

fs.writeFileSync(process.env.XIAOJI_AUDIT_DATA_PATH, `${JSON.stringify({
  [GUILDS.first]: { status: 'approved' },
  [GUILDS.second]: { status: 'approved' },
  [GUILDS.third]: { status: 'approved' },
  [PENDING_GUILD]: { status: 'pending' },
}, null, 2)}\n`);
fs.writeFileSync(process.env.XIAOJI_INVITER_WHITELIST_PATH, '[]\n');

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

const HOOK_NAMES = Object.freeze([
  'interactionCreate', 'messageCreate', 'guildMemberAdd', 'channelDelete', 'voiceStateUpdate',
  'publicCommandCompleted', 'ready', 'shutdown',
]);
const WORK_ROLE_HOOK_NAMES = Object.freeze(['syncAllJobRoles', 'clearPrimaryJobRoleForMember', 'removeJobRoleForMember']);

// The entry file of a synthetic extension. Every hook, the guard and the preflight write down the
// context they ran in; a hook also writes it down after an await, and, when its payload asks, from a timer
// it starts and from a listener it registers.
function extensionSource({ id, commandNames }) {
  return `'use strict';
const path = require('node:path');
const { currentExtensionContext, runOutsideExtensionContext } = require(${JSON.stringify(CONTEXT_MODULE)});

exports.createExtension = () => {
  const seen = [];
  const note = (label) => { seen.push({ label, context: currentExtensionContext() }); };
  const hook = (name) => async (payload = {}) => {
    note('hooks.' + name);
    await new Promise((resolve) => setImmediate(resolve));
    note('hooks.' + name + ':after-await');
    if (payload.startTimer) payload.timers.push(new Promise((resolve) => setTimeout(() => { note('hooks.' + name + ':timer'); resolve(); }, 1)));
    if (payload.emitter) payload.emitter.on('synthetic', () => note('hooks.' + name + ':listener'));
    if (payload.outside) runOutsideExtensionContext(() => note('hooks.' + name + ':outside'));
    if (payload.failure) throw payload.failure;
    return payload.answer;
  };
  const workRole = {};
  for (const name of ${JSON.stringify(WORK_ROLE_HOOK_NAMES)}) workRole[name] = hook('workRole.' + name);
  const hooks = { workRole };
  for (const name of ${JSON.stringify(HOOK_NAMES)}) hooks[name] = hook(name);
  return {
    apiVersion: 1,
    id: ${JSON.stringify(id)},
    commandNames: ${JSON.stringify(commandNames)},
    commandDirectories: [{ id: ${JSON.stringify(`${id}:commands`)}, path: path.join(__dirname, 'commands') }],
    deployment: { guildIds: [] },
    seen,
    async preflight() { note('preflight'); },
    guards: {
      interaction: async (context) => { note('guards.interaction'); return context.answer || { handled: false }; },
    },
    hooks,
  };
};
`;
}

// A slash command that writes down, on the interaction, the context its execute or autocomplete ran in.
function commandSource(name) {
  return `'use strict';
const { currentExtensionContext } = require(${JSON.stringify(CONTEXT_MODULE)});
module.exports = {
  data: { name: ${JSON.stringify(name)}, toJSON: () => ({ name: ${JSON.stringify(name)}, description: 'synthetic', type: 1 }) },
  async execute(interaction) { interaction.seen.push({ label: ${JSON.stringify(`${name}.execute`)}, context: currentExtensionContext() }); },
  async autocomplete(interaction) { interaction.seen.push({ label: ${JSON.stringify(`${name}.autocomplete`)}, context: currentExtensionContext() }); },
};
`;
}

function writeFile(base, relative, text) {
  const target = path.join(base, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

// Writes a deployment root with one public file and one synthetic extension, writes its assembly manifest,
// and loads the extension through loadConfiguredPrivateExtension. commandFiles are the command names that
// get a file in the extension's command directory; commandNames are the ones the extension says it owns.
function loadVerifiedExtension(id, { commandNames, commandFiles }) {
  const deploymentRoot = fs.mkdtempSync(path.join(root, `${id}-`));
  const extensionRoot = `private/${id}`;
  writeFile(deploymentRoot, 'src/placeholder.js', '\'use strict\';\n');
  writeFile(deploymentRoot, `${extensionRoot}/index.js`, extensionSource({ id, commandNames }));
  for (const name of commandFiles) writeFile(deploymentRoot, `${extensionRoot}/commands/${name}.js`, commandSource(name));
  writeFile(deploymentRoot, `${extensionRoot}/assembly-contract.json`, `${JSON.stringify({
    version: 2,
    extensionId: id,
    extensionRelativePath: extensionRoot,
    extensionEntryPath: `${extensionRoot}/index.js`,
    publicJavaScriptRoots: ['src'],
    publicRuntimeFiles: [],
    extensionJavaScriptRoots: [extensionRoot],
    extensionRuntimeFiles: [],
    requiredSharedFiles: [],
  }, null, 2)}\n`);
  const manifestPath = path.join(root, `${id}-assembly-manifest.json`);
  writeAssemblyManifest({ deploymentRoot, contractPath: `${extensionRoot}/assembly-contract.json`, outputPath: manifestPath });
  const extension = loadConfiguredPrivateExtension({
    env: {
      XIAOJI_PRIVATE_EXTENSION_PATH: path.join(deploymentRoot, ...extensionRoot.split('/')),
      XIAOJI_EXTENSION_ASSEMBLY_MANIFEST_PATH: manifestPath,
    },
    projectRoot: deploymentRoot,
  });
  return { extension, entryPath: path.join(deploymentRoot, ...extensionRoot.split('/'), 'index.js') };
}

const alpha = loadVerifiedExtension('synthetic-alpha', {
  commandNames: ['synthetic-alpha-command'],
  commandFiles: ['synthetic-alpha-command', 'synthetic-alpha-unlisted'],
});
const beta = loadVerifiedExtension('synthetic-beta', {
  commandNames: ['synthetic-beta-command'],
  commandFiles: ['synthetic-beta-command'],
});
const publicCommandsPath = path.join(root, 'public-commands');
writeFile(publicCommandsPath, 'synthetic-public-command.js', commandSource('synthetic-public-command'));

// The interaction a command runs for is recorded only for commands; every other entry has none.
function context(extensionId, entry, name, sourceGuildId = null, {
  actorId = null, interactionId = null, interactionTokenDigest: digest = null,
} = {}) {
  return { extensionId, entry, name, sourceGuildId, actorId, interactionId, interactionTokenDigest: digest };
}

const INTERACTION_TOKEN = 'Synthetic-Interaction-Token_AbC.123';
const INTERACTION_DIGEST = crypto.createHash('sha256').update(INTERACTION_TOKEN.toLowerCase(), 'utf8').digest('hex');

function takeSeen(extension) {
  return extension.seen.splice(0).map(({ label, context: seen }) => ({ label, context: seen }));
}

function createInteraction({ client, commandName, guildId = GUILDS.first, kind = 'command', userId = '720000000000000010' }) {
  return {
    id: '720000000000000020',
    token: INTERACTION_TOKEN,
    client,
    guildId,
    channelId: '720000000000000030',
    user: { id: userId },
    commandName,
    seen: [],
    replied: false,
    deferred: false,
    responded: false,
    isAutocomplete: () => kind === 'autocomplete',
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isChatInputCommand: () => kind === 'command',
    reply: async () => {},
    respond: async () => {},
  };
}

async function quietly(run) {
  const original = { info: logger.info, warn: logger.warn, error: logger.error };
  logger.info = () => {};
  logger.warn = () => {};
  logger.error = () => {};
  try {
    return await run();
  } finally {
    Object.assign(logger, original);
  }
}

test('a verified extension runs its preflight, guard and every hook in a context that names it and the source guild', async () => {
  const host = createExtensionHost([alpha.extension]);
  const id = alpha.extension.id;
  takeSeen(alpha.extension);

  await host.preflight({ client: {} });
  await host.guardInteraction({ interaction: { guildId: GUILDS.first }, commandName: 'synthetic-alpha-command' });
  const calls = [
    ['interactionCreate', { interaction: { guildId: GUILDS.first } }, GUILDS.first],
    ['messageCreate', { message: { guildId: GUILDS.second } }, GUILDS.second],
    ['guildMemberAdd', { member: { guild: { id: GUILDS.third } } }, GUILDS.third],
    ['channelDelete', { channel: { guildId: GUILDS.first } }, GUILDS.first],
    ['voiceStateUpdate', { oldState: { guild: { id: GUILDS.first } }, newState: { guild: { id: GUILDS.second } } }, GUILDS.second],
    ['publicCommandCompleted', { interaction: { guildId: GUILDS.third }, action: '/set-welcome' }, GUILDS.third],
    ['ready', { client: {} }, null],
    ['shutdown', { client: {}, signal: 'SIGTERM' }, null],
    ['workRole.syncAllJobRoles', { guild: { id: GUILDS.second } }, GUILDS.second],
    ['workRole.removeJobRoleForMember', { member: { guild: { id: GUILDS.first } }, jobName: 'x' }, GUILDS.first],
    ['workRole.clearPrimaryJobRoleForMember', { client: {}, cycleId: 1, userId: 'u', sourceGuildId: GUILDS.third }, GUILDS.third],
  ];
  for (const [hookName, payload] of calls) await host.runHook(hookName, payload);

  const expected = [
    { label: 'preflight', context: context(id, 'preflight', 'preflight') },
    { label: 'guards.interaction', context: context(id, 'guard', 'guards.interaction', GUILDS.first) },
  ];
  for (const [hookName, , guildId] of calls) {
    const seenContext = context(id, 'hook', `hooks.${hookName}`, guildId);
    expected.push({ label: `hooks.${hookName}`, context: seenContext });
    expected.push({ label: `hooks.${hookName}:after-await`, context: seenContext });
  }
  assert.deepEqual(takeSeen(alpha.extension), expected);
});

test('the source guild comes from the first payload field present, and anything but a snowflake gives none', async () => {
  const host = createExtensionHost([alpha.extension]);
  takeSeen(alpha.extension);
  const cases = [
    [{ interaction: { guildId: null }, guild: { id: GUILDS.first } }, null],
    [{ interaction: { guildId: 'not-a-guild' } }, null],
    [{ interaction: { guild: { id: GUILDS.second } } }, GUILDS.second],
    [{ message: { guildId: 720000000000000001 } }, null],
    [{ member: { guild: { id: GUILDS.first } }, sourceGuildId: GUILDS.third }, GUILDS.first],
    [{ channel: { get guildId() { throw new Error('synthetic getter'); } } }, null],
    [{ sourceGuildId: `${GUILDS.first} ` }, null],
    [{ client: {}, options: { sourceGuildId: GUILDS.first } }, null],
  ];
  for (const [payload] of cases) await host.runHook('interactionCreate', payload);
  const seen = takeSeen(alpha.extension).filter(({ label }) => label === 'hooks.interactionCreate');
  assert.deepEqual(seen.map((entry) => entry.context.sourceGuildId), cases.map(([, guildId]) => guildId));
});

test('a verified extension\'s own command runs in its context through interactionCreate, for execute and autocomplete', async () => {
  const host = createExtensionHost([alpha.extension, beta.extension]);
  const commands = loadCommands(publicCommandsPath, { extensionHost: host, warn: null });
  assert.equal(commands.get('synthetic-alpha-command').xiaojiCommandSource, 'synthetic-alpha');
  assert.equal(commands.get('synthetic-public-command').xiaojiCommandSource, 'public-core');
  const client = { commands, extensionHost: host };

  const executed = createInteraction({ client, commandName: 'synthetic-alpha-command', guildId: GUILDS.second });
  await quietly(() => interactionCreate.execute(executed));
  const completed = createInteraction({ client, commandName: 'synthetic-beta-command', guildId: GUILDS.third, kind: 'autocomplete' });
  await quietly(() => interactionCreate.execute(completed));

  const binding = { actorId: '720000000000000010', interactionId: '720000000000000020', interactionTokenDigest: INTERACTION_DIGEST };
  assert.deepEqual(executed.seen, [{
    label: 'synthetic-alpha-command.execute',
    context: context('synthetic-alpha', 'command', 'synthetic-alpha-command.execute', GUILDS.second, binding),
  }]);
  assert.deepEqual(completed.seen, [{
    label: 'synthetic-beta-command.autocomplete',
    context: context('synthetic-beta', 'command', 'synthetic-beta-command.autocomplete', GUILDS.third, binding),
  }]);
  takeSeen(alpha.extension);
  takeSeen(beta.extension);
});

test('a command context records who ran it and which interaction it answers, never the token itself', async () => {
  const host = createExtensionHost([alpha.extension]);
  const commands = loadCommands(publicCommandsPath, { extensionHost: host, warn: null });
  const command = commands.get('synthetic-alpha-command');
  const client = { commands, extensionHost: host };
  const run = async (interaction) => {
    await host.runCommand(command, 'execute', interaction);
    return interaction.seen.at(-1).context;
  };

  const seen = await run(createInteraction({ client, commandName: 'synthetic-alpha-command', userId: '720000000000000011' }));
  assert.equal(seen.actorId, '720000000000000011');
  assert.equal(seen.interactionId, '720000000000000020');
  assert.equal(seen.interactionTokenDigest, INTERACTION_DIGEST);
  assert.equal(interactionTokenDigest(INTERACTION_TOKEN.toUpperCase()), INTERACTION_DIGEST);
  assert.equal(JSON.stringify(seen).includes(INTERACTION_TOKEN), false);
  assert.equal(JSON.stringify(seen).toLowerCase().includes(INTERACTION_TOKEN.toLowerCase()), false);

  // Fields that are not a snowflake or a token, or that cannot be read, give no binding.
  const odd = createInteraction({ client, commandName: 'synthetic-alpha-command', userId: 7 });
  odd.id = 'not-an-id';
  odd.token = 12;
  assert.deepEqual(await run(odd), context('synthetic-alpha', 'command', 'synthetic-alpha-command.execute', GUILDS.first));
  const oversized = createInteraction({ client, commandName: 'synthetic-alpha-command' });
  oversized.token = 'a'.repeat(1025);
  assert.equal((await run(oversized)).interactionTokenDigest, null);
  const throwing = createInteraction({ client, commandName: 'synthetic-alpha-command' });
  Object.defineProperty(throwing, 'user', { get() { throw new Error('synthetic getter'); } });
  assert.deepEqual(await run(throwing), context('synthetic-alpha', 'command', 'synthetic-alpha-command.execute', GUILDS.first));

  // A hook or a guard that gets an interaction records none of it.
  takeSeen(alpha.extension);
  const interaction = createInteraction({ client, commandName: 'synthetic-alpha-command' });
  await host.runHook('interactionCreate', { interaction });
  await host.guardInteraction({ interaction, commandName: 'synthetic-alpha-command' });
  for (const entry of takeSeen(alpha.extension)) {
    assert.equal(entry.context.actorId, null, entry.label);
    assert.equal(entry.context.interactionId, null, entry.label);
    assert.equal(entry.context.interactionTokenDigest, null, entry.label);
  }
});

test('an extension object that did not come through the verified assembly never gets the context', async () => {
  const plain = require(alpha.entryPath).createExtension();
  const fakeAssembly = { ...alpha.extension.assembly };
  const unverified = [
    ['a plain extension object', plain],
    ['a validated copy with a borrowed assembly', validateExtension(plain, alpha.entryPath, fakeAssembly)],
    ['a copy of the verified extension', { ...alpha.extension }],
  ];
  for (const [label, extension] of unverified) {
    const host = createExtensionHost([extension]);
    extension.seen.splice(0);
    await host.preflight({ client: {} });
    await host.guardInteraction({ interaction: { guildId: GUILDS.first }, commandName: null });
    await host.runHook('interactionCreate', { interaction: { guildId: GUILDS.first } });
    const seen = extension.seen.splice(0);
    assert.deepEqual(seen.map((entry) => entry.label),
      ['preflight', 'guards.interaction', 'hooks.interactionCreate', 'hooks.interactionCreate:after-await'], label);
    assert.ok(seen.every((entry) => entry.context === null), label);

    const commands = loadCommands(publicCommandsPath, { extensionHost: host, warn: null });
    const interaction = createInteraction({ client: { commands, extensionHost: host }, commandName: 'synthetic-alpha-command' });
    await host.runCommand(commands.get('synthetic-alpha-command'), 'execute', interaction);
    assert.deepEqual(interaction.seen.map((entry) => entry.context), [null], label);
  }
});

test('public commands, unlisted commands and commands under another extension\'s name run without the context', async () => {
  const host = createExtensionHost([alpha.extension, beta.extension]);
  const commands = loadCommands(publicCommandsPath, { extensionHost: host, warn: null });
  const client = { commands, extensionHost: host };
  const cases = [
    ['a public command', commands.get('synthetic-public-command'), 'synthetic-public-command'],
    ['a command file the extension does not list', commands.get('synthetic-alpha-unlisted'), 'synthetic-alpha-unlisted'],
    ['one extension\'s command run under the other\'s name', commands.get('synthetic-alpha-command'), 'synthetic-beta-command'],
    ['a command object with no loader mark', { async execute(interaction) {
      interaction.seen.push({ label: 'bare', context: currentExtensionContext() });
    } }, 'synthetic-alpha-command'],
  ];
  assert.equal(commands.get('synthetic-alpha-unlisted').xiaojiCommandSource, 'synthetic-alpha');
  assert.equal(host.ownsCommand('synthetic-alpha-unlisted'), false);
  for (const [label, command, commandName] of cases) {
    const interaction = createInteraction({ client, commandName });
    await host.runCommand(command, 'execute', interaction);
    assert.deepEqual(interaction.seen.map((entry) => entry.context), [null], label);
  }
  await assert.rejects(() => host.runCommand(commands.get('synthetic-alpha-command'), 'handleComponent',
    createInteraction({ client, commandName: 'synthetic-alpha-command' })), TypeError);
});

test('the context stays inside the call: timers inherit it, the caller and later listeners do not', async () => {
  const host = createExtensionHost([alpha.extension]);
  takeSeen(alpha.extension);
  const emitter = new EventEmitter();
  const timers = [];
  const answer = { handled: true };

  assert.equal(currentExtensionContext(), null);
  const results = await host.runHook('messageCreate',
    { message: { guildId: GUILDS.first }, startTimer: true, timers, emitter, outside: true, answer }, { stopOnHandled: true });
  assert.equal(currentExtensionContext(), null, 'the caller is back in its own context');
  assert.deepEqual(results, [{ extensionId: 'synthetic-alpha', result: answer }]);
  assert.equal(results[0].result, answer);
  await Promise.all(timers);
  emitter.emit('synthetic');

  const inside = context('synthetic-alpha', 'hook', 'hooks.messageCreate', GUILDS.first);
  assert.deepEqual(takeSeen(alpha.extension), [
    { label: 'hooks.messageCreate', context: inside },
    { label: 'hooks.messageCreate:after-await', context: inside },
    { label: 'hooks.messageCreate:outside', context: null },
    { label: 'hooks.messageCreate:timer', context: inside },
    { label: 'hooks.messageCreate:listener', context: null },
  ]);

  // A thrown error comes back unchanged and leaves no context behind either.
  const failure = new Error('synthetic hook failure');
  await assert.rejects(() => host.runHook('channelDelete', { channel: { guildId: GUILDS.first }, failure }),
    (error) => error === failure);
  assert.equal(currentExtensionContext(), null);
  const guardAnswer = { handled: true, reason: 'synthetic' };
  assert.equal(await host.guardInteraction({ interaction: { guildId: GUILDS.first }, answer: guardAnswer }), guardAnswer);
  assert.equal(currentExtensionContext(), null);
  takeSeen(alpha.extension);
});

test('the context is frozen, copied on every read, and cannot be faked from the host operation context', async () => {
  const { runWithHostOperationContext } = require('../src/platform/hostOperationContext');
  const fake = { extensionId: 'synthetic-alpha', entry: 'hook', name: 'hooks.messageCreate', sourceGuildId: GUILDS.first };
  assert.equal(runWithHostOperationContext(fake, () => currentExtensionContext()), null);

  const host = createExtensionHost([alpha.extension]);
  takeSeen(alpha.extension);
  await host.runHook('ready', { client: {} });
  const [{ context: seen }] = takeSeen(alpha.extension);
  assert.ok(Object.isFrozen(seen));
  assert.throws(() => { seen.extensionId = 'other'; }, TypeError);
  assert.notEqual(currentExtensionContext(), seen);
});

test('the runner that opens the context can be claimed only once per process', () => {
  assert.throws(() => claimExtensionContextRunner(), (error) => error.code === 'EXTENSION_CONTEXT_RUNNER_CLAIMED');
  assert.equal(runOutsideExtensionContext(() => currentExtensionContext()), null);

  // In a process where nothing claimed it yet, the first claim works and the second throws.
  const script = [
    `const context = require(${JSON.stringify(CONTEXT_MODULE)});`,
    'const runner = context.claimExtensionContextRunner();',
    'let second = "none";',
    'try { context.claimExtensionContextRunner(); } catch (error) { second = error.code; }',
    'const inside = runner.run({ extensionId: "x", entry: "hook", name: "hooks.ready" }, () => context.currentExtensionContext());',
    'let invalid = "none";',
    'try { runner.run({ extensionId: "x", entry: "other", name: "n" }, () => {}); } catch (error) { invalid = error.name; }',
    'process.stdout.write(JSON.stringify({ second, inside, invalid }));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    second: 'EXTENSION_CONTEXT_RUNNER_CLAIMED',
    inside: {
      extensionId: 'x', entry: 'hook', name: 'hooks.ready', sourceGuildId: null,
      actorId: null, interactionId: null, interactionTokenDigest: null,
    },
    invalid: 'TypeError',
  });
});

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

test('only the extension host claims the runner, and only the command loader and the host name the command source', () => {
  const files = sourceFiles(path.join(PROJECT_ROOT, 'src'));
  const naming = (word) => files
    .filter((file) => fs.readFileSync(file, 'utf8').includes(word))
    .map((file) => path.relative(PROJECT_ROOT, file).split(path.sep).join('/'))
    .sort();
  assert.deepEqual(naming('claimExtensionContextRunner'), ['src/extensions/extensionHost.js', 'src/platform/extensionContext.js']);
  assert.deepEqual(naming('xiaojiCommandSource'), ['src/extensions/extensionHost.js', 'src/loadCommands.js']);
});
