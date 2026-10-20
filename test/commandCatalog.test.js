'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { checkProject } = require('../scripts/check-project');
const { buildPublicExportPlan } = require('../scripts/create-public-export');
const { deployCommands } = require('../deploy-commands');
const { createExtensionHost } = require('../src/extensions/extensionHost');
const helpCommand = require('../src/commands/help');
const {
  assertNoPublicPrivateCommandCollisions,
  assertPublicCommandCatalog,
  loadCommandData,
  loadCommands,
  normalizeDescription,
  validateCommandCatalog,
} = require('../src/loadCommands');
const { OWNER_DENIED_MESSAGE } = require('../src/utils/ownerOnly');
const commandCatalog = require('../website/commandCatalog');
const { LEGACY_GAME_STARTS } = require('../website/gameCatalog');

const { COMMAND_ALIASES, COMMAND_AUDIENCES, COMMAND_CATALOG, COMMAND_GROUPS, REMOVED_COMMANDS } = commandCatalog;
const COMMANDS_DIRECTORY = path.join(__dirname, '..', 'src', 'commands');
const SYNTHETIC_CLIENT_ID = '123456789012345678';
const SYNTHETIC_GUILD_ID = '223456789012345678';
const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;

const clone = (value) => JSON.parse(JSON.stringify(value));
const hasIssue = (result, text) => result.issues.some((issue) => issue.includes(text));
const entryOf = (catalog, name) => catalog.COMMAND_CATALOG.find((entry) => entry.name === name);
const isHelpListed = (entry) => entry.listInHelp && entry.audience !== 'owner';
// Audience words from widest to narrowest, written here so the catalog helpers are not their own oracle.
const AUDIENCE_RANK = { public: 0, admin: 1, owner: 2 };
const audienceOf = (entry, subcommand) => (Object.hasOwn(entry.subcommandAudiences || {}, subcommand)
  ? entry.subcommandAudiences[subcommand]
  : entry.audience);
const subcommandsOf = (entry, audience) => entry.subcommands.filter((subcommand) => audienceOf(entry, subcommand) === audience);
// The usage lines /help must show for one command: what members can use, then what needs a server
// permission. A command that is admin-only as a whole has one line. Owner-only subcommands never show.
function helpLinesOf(entry) {
  if (entry.subcommands.length === 0) return [{ usage: `/${entry.name}`, admin: entry.audience === 'admin' }];
  return ['public', 'admin']
    .map((audience) => ({ audience, subcommands: subcommandsOf(entry, audience) }))
    .filter(({ subcommands }) => subcommands.length > 0)
    .map(({ audience, subcommands }) => ({ usage: `/${entry.name} ${subcommands.join('/')}`, admin: audience === 'admin' }));
}

// The helpers below do not use src/loadCommands.js, so the validator is not its own oracle.
function leaves(options = [], parents = []) {
  return options.flatMap((option) => {
    if (option.type === SUBCOMMAND) {
      return [{ path: [...parents, option.name].join(' '), description: option.description }];
    }
    if (option.type === SUBCOMMAND_GROUP) return leaves(option.options, [...parents, option.name]);
    return [];
  });
}

function livePaths(commandData) {
  const paths = new Set();
  for (const command of commandData) {
    paths.add(command.name);
    for (const leaf of leaves(command.options)) {
      const parts = leaf.path.split(' ');
      for (let length = 1; length <= parts.length; length += 1) {
        paths.add(`${command.name} ${parts.slice(0, length).join(' ')}`);
      }
    }
  }
  return paths;
}

// A whole owner-only command for drafts: the public catalog has none (they are private), but the validator
// still holds one to the owner-only rules.
function addOwnerTool(draft) {
  draft.COMMAND_CATALOG.push({
    name: 'owner-tool', description: '擁有者工具', group: 'general', audience: 'owner', listInHelp: false,
    subcommands: ['status'], subcommandAudiences: {},
  });
}

// A mutable copy of the catalog lists, for building broken catalogs.
function draftCatalog(change) {
  const draft = clone({
    COMMAND_ALIASES, COMMAND_AUDIENCES, COMMAND_CATALOG, COMMAND_GROUPS, REMOVED_COMMANDS,
  });
  if (change) change(draft);
  return draft;
}

function helpTextOf(reply) {
  const embed = reply.embeds[0].toJSON();
  return [embed.title, embed.description, ...embed.fields.flatMap((field) => [field.name, field.value])].join('\n');
}

function readHelp(reply) {
  const embed = reply.embeds[0].toJSON();
  const lines = embed.fields.flatMap((field) => field.value.split('\n').map((line) => {
    const match = /^`(\/[^`]+)` - (.+)$/u.exec(line);
    assert.ok(match, `Help line is not a usage line: ${line}`);
    return { group: field.name.replace(/ \d+$/u, ''), usage: match[1], text: match[2] };
  }));
  return { embed, lines, text: helpTextOf(reply) };
}

async function runHelp() {
  let reply = null;
  await helpCommand.execute({ async reply(payload) { reply = payload; } });
  return reply;
}

function writePrivateCommand(directory, commandName) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'private-command.js'), [
    `const { SlashCommandBuilder } = require(${JSON.stringify(require.resolve('discord.js'))});`,
    'module.exports = {',
    `  data: new SlashCommandBuilder().setName(${JSON.stringify(commandName)}).setDescription('synthetic private command'),`,
    '  async execute() {},',
    '};',
  ].join('\n'));
  return createExtensionHost([{
    id: 'synthetic-private',
    commandDirectories: [{ path: directory, guildIds: [SYNTHETIC_GUILD_ID] }],
  }]);
}

test('catalog entries match every public builder exactly', () => {
  const commandData = loadCommandData(undefined, { scope: 'public' });
  const result = validateCommandCatalog(commandData);
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);

  assert.equal(new Set(COMMAND_CATALOG.map((entry) => entry.name)).size, COMMAND_CATALOG.length);
  assert.deepEqual(COMMAND_CATALOG.map((entry) => entry.name).sort(), commandData.map((command) => command.name).sort());
  for (const entry of COMMAND_CATALOG) {
    const live = commandData.find((command) => command.name === entry.name);
    assert.equal(entry.description, live.description, `/${entry.name} description`);
    assert.deepEqual(
      [...entry.subcommands].sort(),
      leaves(live.options).map((leaf) => leaf.path).sort(),
      `/${entry.name} subcommands`,
    );
  }
});

test('the runtime loader, deployment data and catalog describe one command set', () => {
  const commands = loadCommands(undefined, { warn: null });
  const commandData = loadCommandData(undefined, { scope: 'public' });
  assert.equal(commands.size, commandData.length);
  assert.deepEqual([...commands.keys()].sort(), COMMAND_CATALOG.map((entry) => entry.name).sort());
});

test('every command and subcommand description is written in Chinese', () => {
  for (const command of loadCommandData(undefined, { scope: 'public' })) {
    assert.match(command.description, /\p{Script=Han}/u, `/${command.name} description`);
    for (const leaf of leaves(command.options)) {
      assert.match(leaf.description, /\p{Script=Han}/u, `/${command.name} ${leaf.path} description`);
    }
  }
});

test('subcommand descriptions match their audience: owner-only ones say so and member ones never claim otherwise', () => {
  const live = loadCommandData(undefined, { scope: 'public' });
  let ownerOnly = 0;
  for (const entry of COMMAND_CATALOG) {
    const command = live.find((candidate) => candidate.name === entry.name);
    for (const leaf of leaves(command.options)) {
      const label = `/${entry.name} ${leaf.path}`;
      const audience = audienceOf(entry, leaf.path);
      if (audience === 'public') {
        assert.doesNotMatch(leaf.description, /管理員|擁有者|限 ?owner/iu, `${label} is open to members, so its description must not say otherwise`);
      }
      if (audience === 'owner' && entry.audience !== 'owner') {
        ownerOnly += 1;
        assert.match(leaf.description, /擁有者|owner/iu, `${label} is owner-only, so its description must say so`);
        assert.doesNotMatch(leaf.description, /管理員/u, `${label} is owner-only, not an admin feature`);
      }
    }
  }
  assert.ok(ownerOnly >= 7, `only ${ownerOnly} owner-only subcommands were checked`);

  const bank = live.find((candidate) => candidate.name === 'bank');
  const describe = (name) => leaves(bank.options).find((leaf) => leaf.path === name).description;
  assert.equal(describe('rate-set-demand'), '設定活存每日利率（限小吉擁有者）');
  assert.equal(describe('rate-set-fixed'), '設定定存整期利率（限小吉擁有者）');
});

test('catalog data is immutable and uses only declared groups and audiences', () => {
  assert.equal(Object.isFrozen(COMMAND_CATALOG), true);
  assert.equal(COMMAND_CATALOG.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.subcommands)
    && Object.isFrozen(entry.subcommandAudiences)), true);
  assert.equal(Object.isFrozen(COMMAND_ALIASES), true);
  assert.equal(Object.isFrozen(REMOVED_COMMANDS), true);
  assert.deepEqual([...COMMAND_AUDIENCES], ['public', 'admin', 'owner'], 'audiences run from the widest to the narrowest');
  const groupIds = COMMAND_GROUPS.map((group) => group.id);
  assert.equal(new Set(groupIds).size, groupIds.length);
  for (const entry of COMMAND_CATALOG) {
    assert.ok(groupIds.includes(entry.group), `/${entry.name} group`);
    assert.ok(COMMAND_AUDIENCES.includes(entry.audience), `/${entry.name} audience`);
    assert.equal(typeof entry.listInHelp, 'boolean');
    if (entry.audience === 'owner') assert.equal(entry.listInHelp, false, `/${entry.name} is owner-only`);
    for (const [subcommand, audience] of Object.entries(entry.subcommandAudiences)) {
      assert.ok(entry.subcommands.includes(subcommand), `/${entry.name} marks ${subcommand}, which is not a subcommand`);
      assert.ok(COMMAND_AUDIENCES.includes(audience), `/${entry.name} ${subcommand} audience`);
    }
    if (entry.subcommands.length > 0) {
      const ranks = entry.subcommands.map((subcommand) => AUDIENCE_RANK[audienceOf(entry, subcommand)]);
      assert.ok(ranks.every((rank) => rank >= AUDIENCE_RANK[entry.audience]), `/${entry.name} has a subcommand wider than the command`);
      assert.equal(Math.min(...ranks), AUDIENCE_RANK[entry.audience], `/${entry.name} is as wide as its widest subcommand`);
    }
  }
  assert.equal(commandCatalog.getCommand('ping').name, 'ping');
  assert.equal(commandCatalog.getCommand('games'), null);
});

test('the catalog loads as a plain browser script without Node globals', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'website', 'commandCatalog.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const exposed = context.XiaojiCommandCatalog;
  assert.equal(exposed.COMMAND_CATALOG.length, COMMAND_CATALOG.length);
  assert.equal(JSON.stringify(exposed.REMOVED_COMMANDS), JSON.stringify(REMOVED_COMMANDS));
  assert.equal(JSON.stringify(exposed.COMMAND_ALIASES), JSON.stringify(COMMAND_ALIASES));
  assert.equal(exposed.getSubcommandAudience(exposed.getCommand('work'), 'status-user'), 'admin');
  assert.equal(exposed.getSubcommandAudience(exposed.getCommand('work'), 'list'), 'public');
  assert.deepEqual([...exposed.listSubcommands(exposed.getCommand('shop'), 'admin')], ['purchases-user', 'purchases-all']);
  assert.deepEqual([...exposed.listSubcommands(exposed.getCommand('coin-admin'), 'owner')], ['add', 'remove', 'set', 'reset-user']);
});

test('subcommand audiences fall back to the command audience and read plain clones', () => {
  const work = commandCatalog.getCommand('work');
  assert.equal(commandCatalog.getSubcommandAudience(work, 'list'), 'public');
  assert.equal(commandCatalog.getSubcommandAudience(work, 'status-user'), 'admin');
  assert.equal(commandCatalog.getSubcommandAudience(work, 'appeal-review'), 'owner');
  assert.equal(commandCatalog.getSubcommandAudience(commandCatalog.getCommand('word-chain'), 'stop'), 'admin');
  assert.equal(commandCatalog.getSubcommandAudience({ audience: 'owner', subcommandAudiences: {} }, 'anything'), 'owner');
  assert.equal(commandCatalog.getSubcommandAudience(null, 'list'), null);
  assert.equal(commandCatalog.getSubcommandAudience({ audience: 'admin' }, 'toString'), 'admin');
  assert.deepEqual(commandCatalog.listSubcommands(clone(work), 'owner'), ['appeal-review']);
  assert.deepEqual(commandCatalog.listSubcommands({ audience: 'public', subcommands: ['a', 'b'] }, 'public'), ['a', 'b']);
  assert.deepEqual(commandCatalog.listSubcommands(null, 'public'), []);
});

test('the admin and owner-only subcommands are pinned to what the permission checks require', () => {
  // This list is reviewed against the permission checks in src/commands. Changing it is a decision:
  // test/subcommandAccess.test.js proves each of these refuses an ordinary member.
  const restricted = Object.fromEntries(COMMAND_CATALOG.flatMap((entry) => {
    const admin = subcommandsOf(entry, 'admin');
    const owner = subcommandsOf(entry, 'owner');
    return entry.subcommands.length > 0 && entry.audience === 'public' && (admin.length > 0 || owner.length > 0)
      ? [[entry.name, { admin, owner }]]
      : [];
  }));
  assert.deepEqual(restricted, {
    shop: { admin: ['purchases-user', 'purchases-all'], owner: [] },
    work: {
      admin: ['status-user', 'status-all', 'task-add', 'tasks-all', 'pending', 'review', 'admin-remind', 'role-sync', 'payroll-preview', 'payroll-history'],
      owner: ['appeal-review'],
    },
    bank: {
      admin: ['balance-user', 'balance-all', 'fixed-user', 'fixed-all', 'rate-history'],
      owner: ['rate-set-demand', 'rate-set-fixed'],
    },
    'casino-venue': { admin: ['delete-menu', 'reassign', 'reassign-waiter', 'cancel'], owner: [] },
  });
  const coinAdmin = commandCatalog.getCommand('coin-admin');
  assert.equal(coinAdmin.audience, 'admin');
  assert.deepEqual(subcommandsOf(coinAdmin, 'admin'), ['history', 'enable', 'disable']);
  assert.deepEqual(subcommandsOf(coinAdmin, 'owner'), ['add', 'remove', 'set', 'reset-user']);
  // Commands with no marks keep one audience for every subcommand. /economy lost its member
  // subcommand when the leaderboard moved to /leaderboard, so all of it is admin.
  for (const name of ['word-chain', 'number-chain', 'daily-riddle', 'daily-discussion', 'release-announcements', 'economy']) {
    const entry = commandCatalog.getCommand(name);
    assert.equal(entry.audience, 'admin', `/${name}`);
    assert.deepEqual(entry.subcommands.filter((subcommand) => audienceOf(entry, subcommand) !== 'admin'), [], `/${name}`);
  }
  assert.deepEqual(commandCatalog.getCommand('economy').subcommands, ['overview', 'user', 'audit']);
  // The public core ships no whole owner-only command: those live in the private extension (and are tested
  // there). Owner-only is an audience of subcommands here.
  assert.deepEqual(COMMAND_CATALOG.filter((entry) => entry.audience === 'owner').map((entry) => entry.name), []);
});

test('the casino and duel-tower descriptions send players to /board start', () => {
  for (const name of ['casino', 'duel-tower']) {
    const { description } = commandCatalog.getCommand(name);
    assert.ok(description.includes('/board start'), `/${name} description names /board start`);
    assert.doesNotMatch(description, /使用籌碼遊玩|挑戰決鬥塔台|挑戰賭場/u, `/${name} description no longer claims to start games`);
  }
  assert.equal(commandCatalog.getCommand('casino').description, '賭場借款與紀錄；開局請用 /board start');
  assert.equal(commandCatalog.getCommand('duel-tower').description, '決鬥塔台的武器、進度與紀錄；開局請用 /board start');
});

test('owner-only catalog entries refuse a non-owner before doing any work', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const previousOwner = process.env.BOT_OWNER_ID;
  process.env.BOT_OWNER_ID = 'synthetic-owner';
  t.after(() => {
    if (previousOwner === undefined) delete process.env.BOT_OWNER_ID;
    else process.env.BOT_OWNER_ID = previousOwner;
  });

  const commands = loadCommands(undefined, { warn: null });
  // None today (see the pin on the catalog above); the loop holds any whole owner-only command a later change adds.
  const owners = COMMAND_CATALOG.filter((entry) => entry.audience === 'owner');
  for (const entry of owners) {
    const replies = [];
    await commands.get(entry.name).execute({
      commandName: entry.name,
      user: { id: 'synthetic-intruder', tag: 'intruder#0001' },
      guildId: SYNTHETIC_GUILD_ID,
      replied: false,
      deferred: false,
      inGuild: () => true,
      async reply(payload) { replies.push(payload); },
      async followUp(payload) { replies.push(payload); },
    });
    assert.deepEqual(replies, [{ content: OWNER_DENIED_MESSAGE, ephemeral: true }], `/${entry.name} must refuse a non-owner`);
  }
});

test('removed paths are absent from builders, the catalog and the help output', async () => {
  const live = livePaths(loadCommandData(undefined, { scope: 'public' }));
  const catalogPaths = new Set(COMMAND_CATALOG.flatMap((entry) => [
    entry.name, ...entry.subcommands.map((subcommand) => `${entry.name} ${subcommand}`),
  ]));
  assert.equal(new Set(REMOVED_COMMANDS).size, REMOVED_COMMANDS.length);
  for (const removed of REMOVED_COMMANDS) {
    assert.equal(live.has(removed), false, `/${removed} is back in a builder`);
    assert.equal(catalogPaths.has(removed), false, `/${removed} is listed as live in the catalog`);
  }

  const { lines, text } = readHelp(await runHelp());
  const mentions = [...text.matchAll(/(?<![A-Za-z0-9_/-])\/([a-z][a-z0-9-]*)(?: ([a-z][a-z0-9-]*))?/gu)];
  const mentioned = new Set(mentions.flatMap((match) => [match[1], match[2] ? `${match[1]} ${match[2]}` : null])
    .filter(Boolean));
  for (const { usage } of lines) {
    const [name, ...rest] = usage.slice(1).split(' ');
    for (const subcommand of rest.join(' ').split('/').filter(Boolean)) mentioned.add(`${name} ${subcommand}`);
  }
  for (const removed of REMOVED_COMMANDS) assert.equal(mentioned.has(removed), false, `help mentions /${removed}`);
  for (const match of mentions) assert.ok(live.has(match[1]), `help mentions /${match[1]}, which is not a live command`);
});

test('tombstones cover every legacy game start, the campaign flow and the old calendar entries', () => {
  for (const [command, subcommands] of Object.entries(LEGACY_GAME_STARTS)) {
    for (const subcommand of subcommands) {
      assert.ok(REMOVED_COMMANDS.includes(`${command} ${subcommand}`), `/${command} ${subcommand} needs a tombstone`);
    }
  }
  assert.ok(REMOVED_COMMANDS.includes('games'));
  for (const removed of [
    'coin-admin campaign-preview', 'coin-admin campaign-apply', 'coin-admin campaign-history-plan',
    'coin-admin campaign-history-review', 'coin-admin campaign-history-classify', 'coin-admin campaign-history-import',
    'calendar personal-add', 'calendar personal-list', 'calendar personal-delete',
  ]) {
    assert.ok(REMOVED_COMMANDS.includes(removed), `/${removed} needs a tombstone`);
  }
});

test('the merged purchase, leaderboard and quota entries are tombstoned and gone from builders', () => {
  const commandData = loadCommandData(undefined, { scope: 'public' });
  const live = livePaths(commandData);
  const merged = {
    buy: '/shop buy is the only purchase entry',
    'economy leaderboard': '/leaderboard type assets replaced it',
    'quota-list': 'the quota commands were folded into one owner command',
    'quota-reset': 'the quota commands were folded into one owner command',
    'quota-set': 'the quota commands were folded into one owner command',
  };
  for (const [removed, reason] of Object.entries(merged)) {
    assert.ok(REMOVED_COMMANDS.includes(removed), `/${removed} needs a tombstone (${reason})`);
    assert.equal(live.has(removed), false, `/${removed} is back in a builder`);
    const [command, subcommand] = removed.split(' ');
    const entry = commandCatalog.getCommand(command);
    if (subcommand) assert.equal(entry.subcommands.includes(subcommand), false, `/${removed} is back in the catalog`);
    else assert.equal(entry, null, `/${removed} is back in the catalog`);
  }
  for (const replacement of ['shop buy', 'leaderboard']) {
    assert.ok(live.has(replacement), `/${replacement} must exist`);
  }
  assert.equal(commandData.find((command) => command.name === 'economy').options.some((option) => option.name === 'leaderboard'), false);

  const leaderboard = commandData.find((command) => command.name === 'leaderboard');
  const type = leaderboard.options.find((option) => option.name === 'type');
  assert.equal(type.required ?? false, false, 'type defaults to the coin board');
  assert.deepEqual(type.choices.map((choice) => choice.value), ['coins', 'assets']);
  assert.ok(leaderboard.options.some((option) => option.name === 'page'));
});

// Paths (commands and subcommands) whose descriptions are the same once case, spacing, punctuation
// and full-width forms are ignored.
function sharedDescriptions(commandData) {
  const byDescription = new Map();
  const remember = (commandPath, description) => {
    const key = normalizeDescription(description);
    byDescription.set(key, [...(byDescription.get(key) || []), commandPath]);
  };
  for (const command of commandData) {
    remember(command.name, command.description);
    for (const leaf of leaves(command.options)) remember(`${command.name} ${leaf.path}`, leaf.description);
  }
  return [...byDescription.values()].filter((paths) => paths.length > 1);
}

test('paths that share a description are declared as aliases of each other', () => {
  const commandData = loadCommandData(undefined, { scope: 'public' });
  const live = livePaths(commandData);
  const aliasOf = new Map();
  for (const group of COMMAND_ALIASES) {
    assert.ok(group.members.length >= 2, `alias ${group.id} needs two members`);
    for (const member of group.members) {
      assert.ok(live.has(member), `alias ${group.id} names /${member}, which does not exist`);
      assert.equal(aliasOf.has(member), false, `/${member} is in two alias groups`);
      aliasOf.set(member, group.id);
    }
  }

  for (const paths of sharedDescriptions(commandData)) {
    const groups = new Set(paths.map((commandPath) => aliasOf.get(commandPath)));
    assert.equal(groups.size, 1, `${paths.join(', ')} share a description and must be one alias group`);
    assert.equal(groups.has(undefined), false, `${paths.join(', ')} share a description and must be declared`);
  }

  // The purchase, leaderboard and quota overlaps are resolved, so nothing is declared for them.
  for (const id of ['purchase', 'leaderboard', 'quota']) {
    assert.equal(COMMAND_ALIASES.some((group) => group.id === id), false, `the ${id} alias group is resolved`);
  }
  assert.equal(sharedDescriptions(commandData).some((paths) => paths.includes('shop buy')), false);

  // The scan itself finds shared descriptions, so an empty result above means there are none.
  assert.deepEqual(sharedDescriptions([
    { name: 'one', description: '同樣的說明', options: [] },
    { name: 'two', description: ' 同樣的說明。', options: [{ type: SUBCOMMAND, name: 'sub', description: '另一個說明' }] },
    { name: 'three', description: '同樣的說明', options: [] },
  ]), [['one', 'two', 'three']]);
});

test('description normalization ignores case, spacing, punctuation and full-width forms', () => {
  assert.equal(normalizeDescription(' 使用吉幣購買商店商品。'), normalizeDescription('使用吉幣購買商店商品'));
  assert.equal(normalizeDescription('查看：排行榜'), normalizeDescription('查看:排行榜'));
  assert.equal(normalizeDescription('List Items'), normalizeDescription('list  items'));
  assert.notEqual(normalizeDescription('查看排行榜'), normalizeDescription('查看總資產排行榜'));
  assert.equal(normalizeDescription(null), '');
});

test('/help is generated from the catalog and lists exactly the non-owner commands', async () => {
  const reply = await runHelp();
  assert.equal(reply.ephemeral, true);
  assert.equal(reply.embeds.length, 1);
  const { embed, lines, text } = readHelp(reply);

  const expected = COMMAND_GROUPS.flatMap((group) => COMMAND_CATALOG
    .filter((entry) => entry.group === group.id && isHelpListed(entry))
    .flatMap((entry) => helpLinesOf(entry).map((line, position) => ({ group: group.title, entry, position, ...line }))));
  assert.ok(expected.length > 0);
  assert.deepEqual(
    lines.map(({ group, usage }) => ({ group, usage })),
    expected.map(({ group, usage }) => ({ group, usage })),
  );
  for (const [index, line] of expected.entries()) {
    const shown = lines[index];
    assert.equal(shown.text.includes('需管理權限'), line.admin, `${line.usage} admin marker`);
    assert.equal(shown.text.endsWith('；需管理權限'), line.admin, `${line.usage} admin marker ends the line`);
    if (line.position === 0) {
      assert.ok(shown.text.startsWith(line.entry.description), `${line.usage} help text starts with the builder description`);
    } else {
      assert.equal(shown.text, '管理子指令；需管理權限', `${line.usage} is the admin subcommand line`);
    }
  }

  for (const entry of COMMAND_CATALOG.filter((candidate) => candidate.audience === 'owner')) {
    assert.equal(
      lines.some(({ usage }) => usage === `/${entry.name}` || usage.startsWith(`/${entry.name} `)),
      false,
      `owner-only /${entry.name} must not appear in help`,
    );
  }
  for (const entry of COMMAND_CATALOG.filter(isHelpListed)) {
    const shownSubcommands = lines
      .filter(({ usage }) => usage.startsWith(`/${entry.name} `))
      .flatMap(({ usage }) => usage.slice(entry.name.length + 2).split('/'));
    for (const subcommand of subcommandsOf(entry, 'owner')) {
      assert.equal(shownSubcommands.includes(subcommand), false, `owner-only /${entry.name} ${subcommand} must not appear in help`);
    }
    assert.deepEqual(
      [...shownSubcommands].sort(),
      [...subcommandsOf(entry, 'public'), ...subcommandsOf(entry, 'admin')].sort(),
      `/${entry.name} shows every member and admin subcommand once`,
    );
  }
  assert.deepEqual(embed, helpCommand.buildHelpReply().embeds[0].toJSON());
  assert.equal((text.match(/`\/server`/gu) || []).length, 1);

  const total = embed.title.length + embed.description.length
    + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  assert.ok(total <= 6000, `embed has ${total} characters`);
  assert.ok(embed.fields.length <= 25);
  assert.ok(embed.fields.every((field) => field.value.length <= 1024 && field.name.length <= 256));
});

test('/help shows the commands and subcommands that used to be missing or stale', async () => {
  const { lines } = readHelp(await runHelp());
  const usageFor = (name) => lines.find(({ usage }) => usage === `/${name}` || usage.startsWith(`/${name} `)).usage;
  for (const name of ['economy', 'release-announcements', 'coin-admin']) {
    assert.ok(lines.some(({ usage }) => usage.startsWith(`/${name} `)), `/${name} is listed`);
  }
  assert.equal(usageFor('remind'), '/remind add/list/delete');
  assert.ok(usageFor('casino-lobby').split(' ')[1].split('/').includes('stays'));
});

test('/help puts member subcommands on one line, admin ones on a marked line, and hides owner-only ones', async () => {
  const { lines } = readHelp(await runHelp());
  const linesFor = (name) => lines.filter(({ usage }) => usage === `/${name}` || usage.startsWith(`/${name} `));
  const subcommandsIn = (line) => line.usage.split(' ')[1].split('/');

  const work = linesFor('work');
  assert.equal(work.length, 2);
  assert.equal(subcommandsIn(work[0]).length, 14);
  assert.deepEqual(subcommandsIn(work[0]).filter((subcommand) => ['status-user', 'task-add', 'review', 'appeal-review'].includes(subcommand)), []);
  assert.equal(work[0].text.includes('需管理權限'), false);
  assert.equal(work[1].usage, '/work status-user/status-all/task-add/tasks-all/pending/review/admin-remind/role-sync/payroll-preview/payroll-history');
  assert.equal(work[1].text, '管理子指令；需管理權限');

  assert.deepEqual(linesFor('bank').map(({ usage }) => usage.split(' ')[1].split('/').length), [10, 5]);
  assert.equal(linesFor('bank')[1].usage, '/bank balance-user/balance-all/fixed-user/fixed-all/rate-history');
  // /economy is admin-only as a whole: one marked line, no member line. Its leaderboard moved to
  // /leaderboard, which is one member line that names its type option.
  const economy = linesFor('economy');
  assert.deepEqual(economy.map(({ usage }) => usage), ['/economy overview/user/audit']);
  assert.ok(economy[0].text.startsWith('吉幣經濟總覽與紀錄查詢；'));
  assert.ok(economy[0].text.endsWith('；需管理權限'));
  const leaderboard = linesFor('leaderboard');
  assert.deepEqual(leaderboard.map(({ usage }) => usage), ['/leaderboard']);
  assert.ok(leaderboard[0].text.startsWith('查看吉幣餘額或總資產排行榜'));
  assert.ok(leaderboard[0].text.includes('type'));
  assert.equal(leaderboard[0].text.includes('需管理權限'), false);
  assert.deepEqual(linesFor('shop').map(({ usage }) => usage), [
    '/shop list/buy/purchases', '/shop purchases-user/purchases-all',
  ]);
  assert.ok(linesFor('shop')[0].text.includes('購買請用 /shop buy'));
  for (const gone of ['buy', 'quota', 'quota-list', 'quota-reset', 'quota-set']) {
    assert.deepEqual(linesFor(gone), [], `/${gone} is not shown in help`);
  }
  assert.deepEqual(linesFor('casino-venue').map(({ usage }) => usage), [
    '/casino-venue menu/add-menu/order/recipe/make/serve/history',
    '/casino-venue delete-menu/reassign/reassign-waiter/cancel',
  ]);

  // An admin command with owner-only subcommands shows only the ones an admin can use.
  const coinAdmin = linesFor('coin-admin');
  assert.deepEqual(coinAdmin.map(({ usage }) => usage), ['/coin-admin history/enable/disable']);
  assert.ok(coinAdmin[0].text.endsWith('；需管理權限'));
  assert.ok(coinAdmin[0].text.includes('history 指定 campaign-id 的活動對帳限小吉擁有者'));

  // Owner-only subcommands of member commands never appear in any line. (add, remove and set are
  // left out on purpose: /remind, /calendar and /chat-style legitimately have subcommands of those names.)
  const everySubcommand = new Set(lines.flatMap((line) => (line.usage.includes(' ') ? subcommandsIn(line) : [])));
  for (const hidden of ['appeal-review', 'rate-set-demand', 'rate-set-fixed', 'reset-user']) {
    assert.equal(everySubcommand.has(hidden), false, `${hidden} must not be shown`);
  }
});

test('help notes only describe commands that help lists and never use usage backticks', () => {
  const listed = new Set(COMMAND_CATALOG.filter(isHelpListed).map((entry) => entry.name));
  for (const [name, note] of Object.entries(helpCommand.HELP_NOTES)) {
    assert.ok(listed.has(name), `help note for /${name} has no listed command`);
    assert.equal(note.includes('`'), false);
  }
  assert.ok(helpCommand.HELP_NOTES.board.includes('海龜湯'));
});

test('validator accepts subcommand groups written as space-separated paths', () => {
  const grouped = [{
    name: 'tool',
    description: '工具',
    options: [
      {
        type: SUBCOMMAND_GROUP,
        name: 'admin',
        description: '管理',
        options: [
          { type: SUBCOMMAND, name: 'add', description: '新增' },
          { type: SUBCOMMAND, name: 'remove', description: '移除' },
        ],
      },
      { type: SUBCOMMAND, name: 'list', description: '列出' },
      { type: 3, name: 'plain-option', description: '一般選項' },
    ],
  }];
  const catalog = {
    COMMAND_AUDIENCES: ['public', 'admin', 'owner'],
    COMMAND_GROUPS: [{ id: 'general', title: '一般' }],
    COMMAND_CATALOG: [{
      name: 'tool', description: '工具', group: 'general', audience: 'public', listInHelp: true,
      subcommands: ['admin add', 'admin remove', 'list'],
    }],
    COMMAND_ALIASES: [],
    REMOVED_COMMANDS: ['tool admin purge', 'tool legacy'],
  };
  assert.deepEqual(validateCommandCatalog(grouped, { catalog }).issues, []);
  assert.ok(helpTextOf(helpCommand.buildHelpReply(catalog)).includes('`/tool admin add/admin remove/list`'));

  // A catalog written before subcommand audiences existed has no marks and keeps one audience.
  const marked = clone(catalog);
  marked.COMMAND_CATALOG[0].subcommandAudiences = { 'admin remove': 'admin' };
  assert.deepEqual(validateCommandCatalog(grouped, { catalog: marked }).issues, []);
  const markedHelp = helpTextOf(helpCommand.buildHelpReply(marked));
  assert.ok(markedHelp.includes('`/tool admin add/list` - 工具'));
  assert.ok(markedHelp.includes('`/tool admin remove` - 管理子指令；需管理權限'));
  assert.ok(!markedHelp.includes('admin add/admin remove'));

  const groupBack = validateCommandCatalog(grouped, { catalog: { ...catalog, REMOVED_COMMANDS: ['tool admin'] }, helpText: null });
  assert.ok(hasIssue(groupBack, 'Removed path /tool admin exists again in a builder.'));
  assert.ok(hasIssue(groupBack, 'Removed path /tool admin is listed as live in the catalog.'));

  const drifted = clone(catalog);
  drifted.COMMAND_CATALOG[0].subcommands = ['admin add', 'list'];
  assert.ok(hasIssue(validateCommandCatalog(grouped, { catalog: drifted, helpText: null }),
    '/tool subcommands missing from the catalog: admin remove.'));
});

const realHelpText = helpTextOf(helpCommand.buildHelpReply());
const driftCases = [
  {
    name: 'a builder command missing from the catalog',
    catalog: (draft) => { draft.COMMAND_CATALOG = draft.COMMAND_CATALOG.filter((entry) => entry.name !== 'ping'); },
    expect: 'Builder command /ping is missing from the catalog.',
  },
  {
    name: 'a catalog command without a builder',
    catalog: (draft) => {
      draft.COMMAND_CATALOG.push({
        name: 'ghost', description: '不存在', group: 'general', audience: 'public', listInHelp: true, subcommands: [],
      });
    },
    expect: 'Catalog lists /ghost but no public builder defines it.',
  },
  {
    name: 'a description that differs from the builder',
    catalog: (draft) => { entryOf(draft, 'ping').description = '另一段說明'; },
    expect: '/ping description differs',
  },
  {
    name: 'a builder subcommand missing from the catalog',
    catalog: (draft) => { entryOf(draft, 'remind').subcommands = ['add', 'list']; },
    expect: '/remind subcommands missing from the catalog: delete.',
  },
  {
    name: 'a catalog subcommand the builder does not define',
    catalog: (draft) => { entryOf(draft, 'remind').subcommands.push('bogus'); },
    expect: '/remind catalog subcommands not defined by the builder: bogus.',
  },
  {
    name: 'a removed subcommand back in a builder',
    data: (data) => {
      data.find((command) => command.name === 'casino').options.push({ type: SUBCOMMAND, name: 'dice', description: '舊入口' });
    },
    expect: 'Removed path /casino dice exists again in a builder.',
  },
  {
    name: 'a removed command back in a builder',
    data: (data) => { data.push({ name: 'games', description: '舊入口', options: [] }); },
    expect: 'Removed path /games exists again in a builder.',
  },
  {
    name: 'the merged /buy command back in a builder',
    data: (data) => { data.push({ name: 'buy', description: '舊入口', options: [] }); },
    expect: 'Removed path /buy exists again in a builder.',
  },
  {
    name: 'the merged /economy leaderboard back in a builder',
    data: (data) => {
      data.find((command) => command.name === 'economy').options.push({ type: SUBCOMMAND, name: 'leaderboard', description: '舊入口' });
    },
    expect: 'Removed path /economy leaderboard exists again in a builder.',
  },
  {
    name: 'a merged quota command back in the catalog',
    catalog: (draft) => {
      draft.COMMAND_CATALOG.push({
        name: 'quota-set', description: '舊入口', group: 'general', audience: 'owner', listInHelp: false, subcommands: [], subcommandAudiences: {},
      });
    },
    expect: 'Removed path /quota-set is listed as live in the catalog.',
  },
  {
    name: 'a removed subcommand listed as live in the catalog',
    catalog: (draft) => { entryOf(draft, 'casino').subcommands.push('dice'); },
    expect: 'Removed path /casino dice is listed as live in the catalog.',
  },
  {
    name: 'a malformed removed path',
    catalog: (draft) => { draft.REMOVED_COMMANDS.push('Bad Path'); },
    expect: 'Removed path is malformed',
  },
  {
    name: 'a duplicated removed path',
    catalog: (draft) => { draft.REMOVED_COMMANDS.push('games'); },
    expect: 'Removed path /games is listed more than once.',
  },
  {
    // Two builders that end up with the same description, as /buy and /shop buy once did.
    name: 'identical descriptions without an alias declaration',
    data: (data) => { data.find((command) => command.name === 'roll').description = data.find((command) => command.name === 'ping').description; },
    expect: 'but are not declared as aliases of each other',
    alsoExpect: '/roll',
  },
  {
    name: 'identical descriptions split across two alias groups',
    data: (data) => { data.find((command) => command.name === 'roll').description = data.find((command) => command.name === 'ping').description; },
    catalog: (draft) => {
      draft.COMMAND_ALIASES = [
        { id: 'first', members: ['ping', 'fortune'] },
        { id: 'second', members: ['roll', 'weather'] },
      ];
    },
    expect: 'but are not declared as aliases of each other',
  },
  {
    name: 'an alias naming a command no builder defines',
    catalog: (draft) => { draft.COMMAND_ALIASES.push({ id: 'ghost', members: ['ping', 'nothing-here'] }); },
    expect: 'Alias group "ghost" names /nothing-here, which no builder defines.',
  },
  {
    name: 'an alias group with a single member',
    catalog: (draft) => { draft.COMMAND_ALIASES.push({ id: 'lonely', members: ['ping'] }); },
    expect: 'Alias group "lonely" needs at least two members.',
  },
  {
    name: 'a command declared in two alias groups',
    catalog: (draft) => {
      draft.COMMAND_ALIASES.push({ id: 'one', members: ['ping', 'roll'] }, { id: 'two', members: ['ping', 'fortune'] });
    },
    expect: '/ping appears in alias groups "one" and "two".',
  },
  {
    name: 'an owner-only command listed in help',
    catalog: (draft) => { addOwnerTool(draft); entryOf(draft, 'owner-tool').listInHelp = true; },
    expect: 'Owner-only /owner-tool must not be listed in help.',
  },
  {
    name: 'an unknown group',
    catalog: (draft) => { entryOf(draft, 'ping').group = 'nowhere'; },
    expect: 'Catalog entry /ping uses unknown group "nowhere".',
  },
  {
    name: 'an unknown audience',
    catalog: (draft) => { entryOf(draft, 'ping').audience = 'everyone'; },
    expect: 'Catalog entry /ping uses unknown audience "everyone".',
  },
  {
    name: 'a command listed twice',
    catalog: (draft) => { draft.COMMAND_CATALOG.push(clone(entryOf(draft, 'ping'))); },
    expect: 'Catalog lists /ping more than once.',
  },
  {
    name: 'a subcommand audience naming an unknown subcommand',
    catalog: (draft) => { entryOf(draft, 'work').subcommandAudiences.bogus = 'admin'; },
    expect: 'Catalog entry /work marks "bogus", which is not one of its subcommands.',
  },
  {
    name: 'an unknown subcommand audience',
    catalog: (draft) => { entryOf(draft, 'work').subcommandAudiences['status-user'] = 'everyone'; },
    expect: 'Catalog entry /work status-user uses unknown audience "everyone".',
  },
  {
    name: 'a subcommand audience that is not an object',
    catalog: (draft) => { entryOf(draft, 'work').subcommandAudiences = ['status-user']; },
    expect: 'Catalog entry /work must list subcommandAudiences as an object.',
  },
  {
    name: 'a subcommand wider than its command',
    catalog: (draft) => { entryOf(draft, 'coin-admin').subcommandAudiences.history = 'public'; },
    expect: 'Catalog entry /coin-admin history is public, which is wider than its command (admin).',
  },
  {
    name: 'an owner-only command with a member subcommand',
    catalog: (draft) => { addOwnerTool(draft); entryOf(draft, 'owner-tool').subcommandAudiences.status = 'admin'; },
    expect: 'Catalog entry /owner-tool status is admin, which is wider than its command (owner).',
  },
  {
    name: 'a member command whose subcommands all need a permission',
    catalog: (draft) => {
      for (const subcommand of entryOf(draft, 'shop').subcommands) entryOf(draft, 'shop').subcommandAudiences[subcommand] = 'admin';
    },
    expect: 'Catalog entry /shop is public, but its widest subcommand is admin.',
  },
  {
    name: 'an admin command whose subcommands are all owner-only',
    catalog: (draft) => {
      for (const subcommand of ['history', 'enable', 'disable']) entryOf(draft, 'coin-admin').subcommandAudiences[subcommand] = 'owner';
    },
    expect: 'Catalog entry /coin-admin is admin, but its widest subcommand is owner.',
  },
  {
    name: 'a catalog without its required lists',
    catalog: (draft) => { delete draft.REMOVED_COMMANDS; },
    expect: 'Command catalog is missing required lists: REMOVED_COMMANDS.',
  },
  {
    name: 'help that mentions a removed command',
    helpText: `${realHelpText}\n請改用 /games menu`,
    expect: 'Help mentions removed path /games.',
    alsoExpect: 'Help mentions removed path /games menu.',
  },
  {
    name: 'help that lists a removed subcommand in a usage line',
    helpText: `${realHelpText}\n\`/casino loan-borrow/dice\` - 舊入口`,
    expect: 'Help mentions removed path /casino dice.',
  },
  {
    name: 'help that omits a listed command',
    helpText: realHelpText.split('\n').filter((line) => !line.startsWith('`/ping`')).join('\n'),
    expect: 'Help does not list /ping.',
  },
  {
    name: 'help that lists an owner-only command',
    catalog: (draft) => { addOwnerTool(draft); },
    helpText: `${realHelpText}\n\`/owner-tool\` - 擁有者工具`,
    expect: 'Help lists /owner-tool, which the catalog does not list in help.',
  },
  {
    name: 'help that lists a command twice',
    helpText: `${realHelpText}\n\`/ping\` - 再一次`,
    expect: 'Help lists /ping 2 times.',
  },
  {
    name: 'help whose subcommands differ from the catalog',
    helpText: realHelpText.replace('`/remind add/list/delete`', '`/remind time/message`'),
    expect: 'Help usage for /remind differs from the catalog subcommands.',
  },
  {
    name: 'help that lists an admin subcommand on the member line',
    helpText: realHelpText.replace('`/shop list/buy/purchases`', '`/shop list/buy/purchases/purchases-user`'),
    expect: 'Help usage for /shop differs from the catalog subcommands. Expected /shop list/buy/purchases, /shop purchases-user/purchases-all.',
  },
  {
    name: 'help that lists an owner-only subcommand',
    helpText: realHelpText.replace('`/coin-admin history/enable/disable`', '`/coin-admin history/enable/disable/reset-user`'),
    expect: 'Help usage for /coin-admin differs from the catalog subcommands.',
  },
  {
    name: 'help that lists an owner-only subcommand on a line of its own',
    helpText: `${realHelpText}\n\`/work appeal-review\` - 擁有者審核`,
    expect: 'Help usage for /work differs from the catalog subcommands.',
    alsoExpect: 'Help lists /work 3 times.',
  },
  {
    name: 'help that omits the admin subcommand line',
    helpText: realHelpText.split('\n').filter((line) => !line.startsWith('`/bank balance-user')).join('\n'),
    expect: 'Help usage for /bank differs from the catalog subcommands.',
  },
  {
    name: 'help that mentions a removed subcommand on an admin line',
    helpText: realHelpText.replace('`/coin-admin history/enable/disable`', '`/coin-admin history/enable/disable/campaign-preview`'),
    expect: 'Help mentions removed path /coin-admin campaign-preview.',
    alsoExpect: 'Help usage for /coin-admin differs from the catalog subcommands.',
  },
];

for (const driftCase of driftCases) {
  test(`validator rejects ${driftCase.name}`, () => {
    const catalog = draftCatalog(driftCase.catalog);
    const commandData = clone(loadCommandData(undefined, { scope: 'public' }));
    if (driftCase.data) driftCase.data(commandData);
    const options = { catalog };
    if (driftCase.helpText !== undefined) options.helpText = driftCase.helpText;
    const result = validateCommandCatalog(commandData, options);
    const summary = result.issues.join(' | ');
    assert.equal(result.ok, false, summary);
    assert.ok(hasIssue(result, driftCase.expect), `expected "${driftCase.expect}" in: ${summary}`);
    if (driftCase.alsoExpect) assert.ok(hasIssue(result, driftCase.alsoExpect), `expected "${driftCase.alsoExpect}" in: ${summary}`);
  });
}

test('validator accepts identical descriptions that are declared as aliases of each other', () => {
  const makeSame = (data) => {
    data.find((command) => command.name === 'roll').description = data.find((command) => command.name === 'ping').description;
  };
  const catalog = draftCatalog((draft) => {
    entryOf(draft, 'roll').description = entryOf(draft, 'ping').description;
    draft.COMMAND_ALIASES = [{ id: 'same', members: ['ping', 'roll'], note: '同一件事的兩個入口。' }];
  });
  const commandData = clone(loadCommandData(undefined, { scope: 'public' }));
  makeSame(commandData);
  assert.deepEqual(validateCommandCatalog(commandData, { catalog }).issues, []);

  const undeclared = draftCatalog((draft) => { entryOf(draft, 'roll').description = entryOf(draft, 'ping').description; });
  assert.ok(hasIssue(validateCommandCatalog(commandData, { catalog: undeclared }), 'but are not declared as aliases of each other'));
});

test('validator can skip the help checks and never mutates its inputs', () => {
  const commandData = loadCommandData(undefined, { scope: 'public' });
  const before = JSON.stringify(commandData);
  const brokenHelp = validateCommandCatalog(commandData, { helpText: 'nothing useful' });
  assert.equal(brokenHelp.ok, false);
  assert.equal(validateCommandCatalog(commandData, { helpText: null }).ok, true);
  assert.equal(JSON.stringify(commandData), before);
});

test('assertPublicCommandCatalog throws every issue with a stable code', () => {
  const commandData = loadCommandData(undefined, { scope: 'public' });
  assert.equal(assertPublicCommandCatalog(commandData).ok, true);
  assert.equal(assertPublicCommandCatalog().ok, true);

  const drifted = draftCatalog((draft) => {
    entryOf(draft, 'ping').description = '另一段說明';
    entryOf(draft, 'remind').subcommands = ['add'];
  });
  assert.throws(
    () => assertPublicCommandCatalog(commandData, { catalog: drifted }),
    (error) => error.code === 'COMMAND_CATALOG_INVALID'
      && error.issues.length >= 2
      && error.message.startsWith('Command catalog validation failed:\n- ')
      && error.message.includes('/ping description differs')
      && error.message.includes('/remind subcommands missing from the catalog'),
  );
});

test('deployCommands refuses a drifted catalog before any Discord request', async () => {
  const calls = [];
  const rest = {
    async get(...args) { calls.push(['get', ...args]); return []; },
    async put(...args) { calls.push(['put', ...args]); return []; },
  };
  const drifted = draftCatalog((draft) => { entryOf(draft, 'ping').description = '另一段說明'; });
  await assert.rejects(
    deployCommands({ clientId: SYNTHETIC_CLIENT_ID, rest, publicOnly: true, testControlPolicy: null, commandCatalog: drifted, protectedGuildIds: null, ownerGuildId: null }),
    (error) => error.code === 'COMMAND_CATALOG_INVALID' && error.message.includes('/ping description differs'),
  );
  await assert.rejects(
    deployCommands({ clientId: SYNTHETIC_CLIENT_ID, rest, dryRun: true, publicOnly: true, testControlPolicy: null, commandCatalog: drifted, protectedGuildIds: null, ownerGuildId: null }),
    (error) => error.code === 'COMMAND_CATALOG_INVALID',
  );
  assert.deepEqual(calls, []);

  const result = await deployCommands({
    clientId: SYNTHETIC_CLIENT_ID, rest, dryRun: true, publicOnly: true, testControlPolicy: null, protectedGuildIds: null, ownerGuildId: null,
  });
  // A whole owner-only command is not global: it goes to the owner guild (test/ownerGuildDeployment.test.js).
  assert.equal(result.globalCount, COMMAND_CATALOG.filter((entry) => entry.audience !== 'owner').length);
  assert.deepEqual(calls, []);
});

test('deployment rejects a private command that reuses a public command name', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-command-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const colliding = writePrivateCommand(path.join(root, 'colliding'), 'ping');
  const distinct = writePrivateCommand(path.join(root, 'distinct'), 'synthetic-private-tool');

  await assert.rejects(
    deployCommands({ clientId: SYNTHETIC_CLIENT_ID, dryRun: true, extensionHost: colliding, testControlPolicy: null, protectedGuildIds: null, ownerGuildId: null }),
    /Private slash commands collide with public commands: \/ping$/u,
  );
  assert.throws(
    () => loadCommandData(undefined, { scope: 'all', extensionHost: colliding }),
    /Private slash commands collide with public commands: \/ping$/u,
  );

  const result = await deployCommands({
    clientId: SYNTHETIC_CLIENT_ID, dryRun: true, extensionHost: distinct, testControlPolicy: null, protectedGuildIds: null, ownerGuildId: null,
  });
  assert.equal(result.globalCount, COMMAND_CATALOG.filter((entry) => entry.audience !== 'owner').length);
  assert.equal(result.privateCommandCount, 1);
  assert.equal(result.privateGuildCount, 1);
  assert.equal(loadCommandData(undefined, { scope: 'all', extensionHost: distinct }).length, COMMAND_CATALOG.length + 1);
});

test('public and private name collisions are reported once per name', () => {
  assert.doesNotThrow(() => assertNoPublicPrivateCommandCollisions([{ name: 'a' }], [{ name: 'b' }]));
  assert.throws(
    () => assertNoPublicPrivateCommandCollisions([{ name: 'a' }, { name: 'b' }], [{ name: 'b' }, { name: 'b' }, { name: 'c' }]),
    /Private slash commands collide with public commands: \/b$/u,
  );
});

test('startup only warns about catalog drift and never stops loading', () => {
  const drifted = draftCatalog((draft) => {
    entryOf(draft, 'ping').description = '另一段說明';
    draft.COMMAND_CATALOG = draft.COMMAND_CATALOG.filter((entry) => entry.name !== 'roll');
  });
  const warnings = [];
  const commands = loadCommands(undefined, { catalog: drifted, warn: (message) => warnings.push(message) });
  assert.equal(commands.size, COMMAND_CATALOG.length);
  assert.ok(warnings.length >= 2);
  assert.ok(warnings.every((message) => message.startsWith('[COMMAND_CATALOG] ')));
  assert.ok(warnings.some((message) => message.includes('/ping description differs')));
  assert.ok(warnings.some((message) => message.includes('Builder command /roll is missing from the catalog.')));

  const clean = [];
  loadCommands(undefined, { warn: (message) => clean.push(message) });
  assert.deepEqual(clean, []);

  const customPath = [];
  loadCommands(COMMANDS_DIRECTORY, { catalog: drifted, warn: (message) => customPath.push(message) });
  assert.deepEqual(customPath, [], 'a custom commands path is not the public command set');

  const malformed = [];
  assert.doesNotThrow(() => loadCommands(undefined, { catalog: {}, warn: (message) => malformed.push(message) }));
  assert.ok(malformed.some((message) => message.includes('missing required lists')));

  assert.doesNotThrow(() => loadCommands(undefined, { catalog: drifted, warn: null }));

  const flooded = [];
  const everyDescriptionChanged = draftCatalog((draft) => {
    for (const entry of draft.COMMAND_CATALOG) entry.description = `${entry.description}！`;
  });
  loadCommands(undefined, { catalog: everyDescriptionChanged, warn: (message) => flooded.push(message) });
  assert.equal(flooded.length, 11);
  assert.match(flooded.at(-1), /^\[COMMAND_CATALOG\] \d+ more issue\(s\) not shown\.$/u);
});

test('npm run check fails when the catalog drifts', () => {
  const drifted = draftCatalog((draft) => { entryOf(draft, 'ping').description = '另一段說明'; });
  assert.throws(
    () => checkProject({ commandCatalog: drifted }),
    (error) => error.message.includes('Command catalog validation failed')
      && error.message.includes('/ping description differs'),
  );
});

test('the public export includes the catalog and this test', () => {
  const files = buildPublicExportPlan();
  assert.ok(files.includes('website/commandCatalog.js'));
  assert.ok(files.includes('test/commandCatalog.test.js'));
});
