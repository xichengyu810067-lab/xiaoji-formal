'use strict';

// Every public slash command path, run the way a started bot runs it, by two users:
//   owner       the bot owner, in the sweep's guild, where the owner also holds Administrator;
//   member      a member without any server permission, in the same guild;
// and, for every path a user can also reach in direct messages with the bot, by that member there.
//
// Each run goes through the real interaction handler (src/events/interactionCreate.js: the extension guard, the
// handler's own "command failed" guard), the real command, the real services and a real coin database in a temporary
// directory. The board and solo game runtimes (with a synthetic turtle-soup corpus), the reward and work-role
// coordinators and the public side-effect runtime are set up as src/index.js sets them up. Only Discord, the network
// and chance are fake (test/support/slashCommandSweep.js): the guilds, users, channels and messages, the interactions,
// a fetch that answers every request with 503, the turtle-soup judge's model client, and seeded random numbers, so
// every sweep classifies every run the same way.
//
// The first pass runs each path as each user with every option filled, then with the required options only, and in
// the approved guild once for every other choice of every option; every game of /board start is started by the owner
// and by the member, each in a channel of its own (see plannedRuns). Right after the path that showed them, the
// component pass presses the buttons and submits the modals the first pass left on screen (boards, personal games,
// blackjack, the poll, the coin-admin previews), as the member and as the owner, through the same handler (see
// COMPONENT_SOURCES); before either of them uses a control or submits a modal, an outsider (a member who is in no
// game and owns no panel) tries it. The autocomplete
// pass asks every option that suggests values for its suggestions, for every game typed before it. The long-data pass
// runs every path again after a page of long entries was created (see LONG_DATA_SEEDS).
//
// A run passes when the user got an answer that Discord would accept and that reads like an answer: a reply, a
// deferral followed by an edit or a follow-up, a modal, an update of the message a component was on, or one
// suggestion list; no second first answer; nothing Discord would refuse (2000 characters, embed, component and
// suggestion limits, an empty message); no text showing undefined, NaN, null, a raw object, a stack trace, a path or
// a raw database error; not the handler's "command failed" answer, nor an answer made of a failure phrase
// (FRIENDLY_REFUSALS in the support file lists the refusals that use one and are still right), nor a logged error
// whose code does not mean a refusal (DOMAIN_CODES there), nor a logged warning that is not harmless
// (HARMLESS_WARNINGS); no network request unless the command is one that is meant to make them (NETWORK_COMMANDS). Who may do what follows the command catalog: the owner is never refused, the
// member is refused on every admin and owner path and nowhere else (RUN_EXCEPTIONS lists the exceptions with their
// reasons), and the direct-message user is refused on every admin and owner path. A refused run must have changed
// nothing: no table of the coin database (but the interaction count, REFUSAL_MAY_CHANGE), no file of the temporary
// root, no message, reaction, thread or REST request, and not the message a pressed control was on. Suggestions change
// nothing, whoever asks.
//
// Set XIAOJI_SWEEP_REPORT to a file path to get every run as JSON (path, user, result, the first 80 characters of
// the answer).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { ApplicationCommandOptionType } = require('discord.js');

const sweep = require('./support/slashCommandSweep');

// Before anything under src loads: modules take node:crypto's random functions while they load.
const restoreRandomness = sweep.installDeterministicRandomness();
// Read before the environment is cleared of every XIAOJI_ variable.
const REPORT_PATH = process.env.XIAOJI_SWEEP_REPORT || null;
const environment = sweep.createSweepEnvironment('xiaoji-slash-sweep-');
const restoreFetch = sweep.installOfflineFetch();
const restoreLogger = sweep.captureLogger();
const restoreRejections = sweep.captureUnhandledRejections();

const { loadCommands } = require('../src/loadCommands');
const interactionCreate = require('../src/events/interactionCreate');
const { createExtensionHost } = require('../src/extensions/extensionHost');
const { configureBoardRuntime, resetBoardRuntimeForTests } = require('../src/games/boardRuntimeRegistry');
const { createBoardDiscordRuntime } = require('../src/games/discord/boardDiscordRuntime');
const { buildScenarioIndex, prepareFileScenarioProvider } = require('../src/games/turtleSoup/scenarioProvider');
const { createJudgeProvider } = require('../src/games/turtleSoup/providerAdapter');
const { CONTROL_DEFINITIONS: BOARD_CONTROL_DEFINITIONS } = require('../src/games/discord/boardControls');
const { configureSoloRuntime } = require('../src/systems/games/soloRuntimeRegistry');
const { createDefaultSoloDiscordRuntime } = require('../src/systems/games/soloDiscordRuntime');
const { createRuntimeRewardCoordinator } = require('../src/coordinators/rewardRuntime');
const { configureWorkRewardCoordinator } = require('../src/systems/work/workRewardPort');
const { workRoleCoordinator } = require('../src/coordinators/workRoleCoordinator');
const { configureWorkRoleCoordinator } = require('../src/systems/work/workRolePort');
const { configureArchivePathResolver } = require('../src/services/aiArchiveService');
const { resolveDataPath } = require('../src/platform/dataPaths');
const { createPublicEffectAuthority } = require('../src/platform/publicEffectGrant');
const { configurePublicEffectAdapter } = require('../src/platform/publicEffectAdapter');
const { configureChainReactionFence } = require('../src/systems/safety/chainReactionFence');
const { PublicSideEffectRuntime } = require('../src/systems/safety/publicSideEffectRuntime');
const { initializePublicLedgers, openPublicLedgers } = require('./fixtures/publicLedgers');
const { createSyntheticRest } = require('./fixtures/syntheticRest');
const logger = require('../src/utils/logger');
const bankService = require('../src/services/bankService');
const coinService = require('../src/services/coinService');
const luxuryService = require('../src/services/luxuryService');
const workService = require('../src/services/workService');
const { setGuildFeatureSetting } = require('../src/services/featurePlatformService');
const { corpusVersion: dailyRiddleCorpusVersion } = require('../src/services/dailyRiddleCorpus');
const { COMMAND_CATALOG, getSubcommandAudience } = require('../website/commandCatalog');
const { GAME_CATALOG } = require('../website/gameCatalog');

const { IDS } = sweep;

// A fixed Monday noon in Taipei, so every run sees the same day and hour; each run moves the clock one second on.
const SWEEP_START = Date.parse('2026-03-02T04:00:00.000Z');

// The two users of every path, and the member once more in direct messages with the bot: the public commands are
// deployed globally, so every one of them that its builder does not keep to guilds can also be run there.
const ACTORS = Object.freeze([
  Object.freeze({ key: 'owner', user: 'owner', guild: 'approved' }),
  Object.freeze({ key: 'member', user: 'member', guild: 'approved' }),
  Object.freeze({ key: 'direct-message', user: 'member', guild: null }),
]);
const EVERY_PATH_ACTORS = Object.freeze(['owner', 'member']);

// Paths the fake cannot run, by path, with the reason. Every entry must name a path that exists.
const EXCLUDED_PATHS = Object.freeze({});

// Defects this sweep found that are reported and not fixed yet, by "path|run" with the reason as the value. Each such
// run is a todo test: it still runs and is still checked, and it starts to pass once the defect is fixed.
const KNOWN_DEFECTS = Object.freeze({});

// The commands that are meant to reach the network. A run of any other command that makes a request fails.
const NETWORK_COMMANDS = Object.freeze(new Set([
  // /weather asks the weather services; offline it answers that the weather cannot be read now.
  'weather',
]));

// Runs whose result differs from what the command catalog says about who may run the path, by "path|run", with the
// categories they must have instead and why.
const RUN_EXCEPTIONS = Object.freeze({
  'board start|member, game=word-chain': Object.freeze({
    expect: ['denied'],
    reason: '/board is public, but starting a word chain sets the channel up and needs Manage Server '
      + '(src/systems/community/discord/wordChainLaunch.js, ensureWordChainAccess)',
  }),
  'board start|member, game=number-chain': Object.freeze({
    expect: ['denied'],
    reason: '/board is public, but starting a number chain sets the channel up and needs Manage Server '
      + '(src/systems/community/discord/numberChainLaunch.js)',
  }),
});

// Option values that differ from the generated ones for one path (an override of undefined leaves the option out).
const PATH_OPTION_OVERRIDES = Object.freeze({
  // With both a user and a role the command only asks to choose one; with the user alone it shows the add preview
  // and its confirm buttons.
  'coin-admin add': Object.freeze({ role: undefined, 'campaign-id': undefined }),
  // /casino-venue delete-menu has just deleted menu item 1; order the next meal and the first drink of the default
  // menu instead.
  'casino-venue order': Object.freeze({ meal: 2, drink: 4 }),
});

// Runs of the first pass beyond the planned ones, by path.
const EXTRA_RUNS = Object.freeze({
  // The role preview of /coin-admin add: a campaign for the sweep role, with its member list and confirm buttons.
  'coin-admin add': Object.freeze([Object.freeze({
    actor: 'owner', label: 'owner, role preview',
    overrides: Object.freeze({ user: undefined, role: IDS.role, 'campaign-id': 'sweep-role-campaign' }),
  })]),
});

// /board start, game by game: a valid bet for the casino games that take one.
const CASINO_CHOICES = Object.freeze({ 'casino-dice': 'big', 'casino-roulette': 'red', 'casino-baccarat': 'player' });

// What the first answer of a /board start shows when the game really started, by launcher.
const GAME_LAUNCHED = Object.freeze({
  board: (result) => result.effects.includes('message.edit (1 file)'),
  solo: (result) => result.customIds.some((customId) => customId.startsWith('solo|1|')),
  'word-chain': (result) => result.reply.startsWith('文字接龍開始'),
  'number-chain': (result) => result.reply.startsWith('數字接龍開始'),
  'daily-riddle': (result) => /^今天的每日猜謎在 <#\d+>/u.test(result.reply),
  duel: (result) => result.reply.startsWith('**決鬥塔台｜挑戰結算**'),
  casino: (result) => /^\*\*小吉賭場｜|開了一局 21 點/u.test(result.reply),
});

// Paths whose run changes what every later path sees. After every user ran it, the state is put back through
// the real service, so the rest of the sweep runs with the coin system on.
const RESTORE_AFTER = Object.freeze({
  'coin-admin disable': () => coinService.setGuildEconomyEnabled(IDS.approvedGuild, true, { operatorId: IDS.owner }),
});

// The second pass runs every path again after the approved guild holds a page of what its members and admins can
// create, written by running the command that creates it ten times with every free-text option at the longest length
// the option accepts: menu items, reminders, calendar events and fixed deposits (by the member), and what the member
// then does with them: purchases, pawn records, chips, and balance changes with the longest reason (by the owner).
// (The shop and luxury items themselves are made through the services below: the commands that create them are
// private commands now, and their long-text checks are in the private test suite.) In that pass the free-text options of every path are at their
// longest too. Whatever a command shows has to fit Discord's limits however long the stored text is.
const LONG_DATA_SEEDS = Object.freeze([
  Object.freeze({ path: 'casino-venue add-menu', actor: 'member' }),
  Object.freeze({ path: 'remind add', actor: 'member' }),
  Object.freeze({ path: 'calendar add', actor: 'member' }),
  Object.freeze({ path: 'bank fixed-create', actor: 'member' }),
  Object.freeze({ path: 'shop buy', actor: 'member' }),
  Object.freeze({ path: 'luxury buy', actor: 'member' }),
  Object.freeze({ path: 'pawn sell', actor: 'member' }),
  Object.freeze({ path: 'exchange buy-chips', actor: 'member' }),
  Object.freeze({ path: 'coin-admin remove', actor: 'owner' }),
]);
const LONG_DATA_COPIES = 10;
const LONG_DATA = ', long data';
// What the seeds above cannot make by running one command, because the item ids are only known afterwards: the items
// with a name and a description at their longest, each bought by the member, some by the target, and some of them
// pawned; and fixed deposits of the target. They are made through the real services, the way the commands do.
const LONG_ITEM_COUNT = 16;
const LONG_ITEM_NAME = '掃描長文字測試，'.repeat(10);

// Synthetic turtle-soup scenarios: the public core ships no corpus, so the sweep writes these into its temporary root
// and builds their index, the way an operator prepares a corpus for TURTLE_SOUP_CORPUS_ROOT.
const TURTLE_SOUP_SCENARIOS = Object.freeze([
  ['synthetic-red-door', '合成測試題：紅門', '有人回家後看見紅門，便知道計畫成功。為什麼？', '紅門被鎖。', '鑰匙在杯子下。'],
  ['synthetic-blue-lamp', '合成測試題：藍燈', '店員看到藍燈亮起就關店了。為什麼？', '藍燈表示停電。', '停電時收銀機會關機。'],
  ['synthetic-green-key', '合成測試題：綠鑰匙', '她拿到綠鑰匙後就不再害怕了。為什麼？', '綠鑰匙能打開安全室。', '安全室裡有電話。'],
].map(([id, title, publicPrompt, firstFact, secondFact]) => Object.freeze({
  schemaVersion: 1,
  id,
  version: 1,
  locale: 'zh-TW',
  difficulty: 'easy',
  title,
  publicPrompt,
  revealText: `合成揭曉：${firstFact}${secondFact}`,
  facts: [
    { id: 'first_fact', statement: firstFact, keywords: [firstFact.slice(0, 2)] },
    { id: 'second_fact', statement: secondFact, keywords: [secondFact.slice(0, 2)] },
  ],
  solutionFactIds: ['first_fact', 'second_fact'],
  contradictions: [{ id: 'not_broken', statement: '沒有東西損壞。' }],
  tags: ['synthetic'],
})));

function writeSyntheticTurtleSoupCorpus(root) {
  const corpusRoot = path.join(root, 'turtle-soup');
  fs.mkdirSync(corpusRoot);
  for (const scenario of TURTLE_SOUP_SCENARIOS) {
    fs.writeFileSync(path.join(corpusRoot, `${scenario.id}.json`), JSON.stringify(scenario), 'utf8');
  }
  buildScenarioIndex({ rootDir: corpusRoot });
  return corpusRoot;
}

// The turtle-soup judge's model client, faked like the network: it answers every judgment with 無法判定, a verdict
// both questions and guesses accept, so the game goes on without a provider and nothing is sent anywhere.
const SYNTHETIC_JUDGE_CLIENT = Object.freeze({
  chat: Object.freeze({
    completions: Object.freeze({
      async create() {
        return { choices: [{ message: { content: JSON.stringify({ verdict: '無法判定' }) } }] };
      },
    }),
  }),
});

const extensionHost = createExtensionHost();
const commands = loadCommands(undefined, { extensionHost });
const PATHS = sweep.flattenCommandPaths(commands);
// A whole owner-only command is deployed to the owner guild alone, never globally, so nobody can run it in direct
// messages. The public catalog has none today (they are private commands); the rule stays for one that is added.
const OWNER_GUILD_COMMANDS = new Set(COMMAND_CATALOG.filter((entry) => entry.audience === 'owner').map((entry) => entry.name));

function runsInDirectMessages(entry) {
  return sweep.runsInDirectMessages(entry) && !OWNER_GUILD_COMMANDS.has(entry.commandName);
}

// Who the command catalog says a path is for: public, admin or owner.
function audienceOf(entry) {
  const catalogEntry = COMMAND_CATALOG.find((candidate) => candidate.name === entry.commandName);
  const subcommand = entry.key.split(' ').slice(1).join(' ');
  return subcommand ? getSubcommandAudience(catalogEntry, subcommand) : catalogEntry.audience;
}

const items = {};
const results = [];
const componentResults = [];
const autocompleteResults = [];
const sweptPaths = new Set();
let world;
let publicSideEffects = null;
// What the bot keeps (the coin database, the files of the temporary root), watched run by run.
let stateTracker = null;
let runCount = 0;
let startedAt = 0;

// The item each item-id option names: the shop commands use the shop items, the luxury and pawn commands the luxury ones.
function itemIdFor(commandPath) {
  if (commandPath.startsWith('luxury') || commandPath.startsWith('pawn')) return items.luxury;
  return items.shop;
}

// The public side-effect runtime as a healthy start leaves it: src/index.js builds it, the ledger bootstrap delivers
// one ledger per purpose, and it is armed at ClientReady. Here the ledgers are initialized offline in the sweep's
// temporary root (test/fixtures/publicLedgers.js) and its REST is synthetic: every request is written down on the run
// and answered without the network.
function armPublicSideEffects() {
  const ledgerRoot = path.join(environment.root, 'ledgers');
  fs.mkdirSync(ledgerRoot);
  const ledgers = initializePublicLedgers({ root: ledgerRoot, name: 'sweep', botId: IDS.bot, cutover: SWEEP_START - 60_000 });
  const record = (method) => async (route) => {
    sweep.noteEffect({ kind: 'rest', method, route });
    return method === 'post' ? { id: `${IDS.bot.slice(0, -1)}7`, channel_id: route.split('/')[2] } : {};
  };
  const rest = createSyntheticRest({ get: record('get'), post: record('post'), put: record('put'),
    patch: record('patch'), delete: record('delete') });
  const authority = createPublicEffectAuthority();
  const runtime = new PublicSideEffectRuntime({
    client: { rest }, botId: IDS.bot, logger, env: {}, now: () => Date.now(), effectAuthority: authority,
  });
  runtime.preflight({ ledgers: openPublicLedgers(ledgers, { botId: IDS.bot, now: () => Date.now() }) });
  runtime.arm();
  configurePublicEffectAdapter({
    publicEffectRuntime: runtime, publicEffectIssuer: authority.createIssuer(), publicEffectAuthority: authority,
  });
  configureChainReactionFence(runtime);
  return runtime;
}

// What src/index.js configures before it logs in and at ready, without what needs Discord itself (the ledger
// bootstrap's identity check, the owner notices, the egress guard).
function configureRuntimes(client) {
  publicSideEffects = armPublicSideEffects();
  configureArchivePathResolver(resolveDataPath);
  process.env.TURTLE_SOUP_CORPUS_ROOT = writeSyntheticTurtleSoupCorpus(environment.root);
  const turtleSoupCorpus = prepareFileScenarioProvider({ rootDir: process.env.TURTLE_SOUP_CORPUS_ROOT });
  assert.equal(turtleSoupCorpus.readiness.ready, true, 'the synthetic turtle-soup corpus is ready');
  client.boardRuntime = configureBoardRuntime(createBoardDiscordRuntime({
    client,
    scenarioProvider: turtleSoupCorpus.provider,
    scenarioProviderReadiness: turtleSoupCorpus.readiness,
    judgeProvider: createJudgeProvider({ client: SYNTHETIC_JUDGE_CLIENT, model: 'synthetic-judge', logger }),
  }));
  const rewardCoordinator = createRuntimeRewardCoordinator();
  client.soloRuntime = configureSoloRuntime(createDefaultSoloDiscordRuntime({
    client, runtimeLogger: logger, rewardCoordinator,
  }));
  configureWorkRewardCoordinator(rewardCoordinator);
  configureWorkRoleCoordinator(workRoleCoordinator);
}

// Wallets and items made through the real services, so the money and item paths do real work; the battle item the
// duel tower needs, owned by both users; and the daily riddle switched on in a channel of its own, so /board start
// can open today's riddle.
async function seedEconomy() {
  const guildId = IDS.approvedGuild;
  await coinService.setGuildEconomyEnabled(guildId, true, { operatorId: IDS.owner });
  for (const [userId, amount] of [[IDS.owner, 10_000_000], [IDS.member, 10_000_000], [IDS.target, 1_000_000]]) {
    await coinService.adjustPlayerBalance(guildId, userId, {
      action: 'add', amount, operatorId: IDS.owner, reason: '掃描測試初始資金', operationId: `sweep-seed-${userId}`,
    });
  }
  const shopItem = (name, type) => coinService.createShopItem(guildId, { name, price: 10, type, createdBy: IDS.owner });
  items.shop = (await shopItem('掃描測試徽章', 'collectible')).id;
  items.weapon = (await shopItem('掃描測試木劍', 'battle_item')).id;
  const luxuryItem = (name) => luxuryService.createLuxuryItem(guildId, { name, price: 100, createdBy: IDS.owner });
  items.luxury = (await luxuryItem('掃描測試名錶')).id;
  for (const userId of [IDS.owner, IDS.member]) await coinService.purchaseItem(guildId, userId, items.weapon, 1);
  await setGuildFeatureSetting(guildId, 'daily_riddle', {
    enabled: true, channelId: world.channelFor('daily-riddle').id, config: { corpusVersion: dailyRiddleCorpusVersion },
  });
}

// The runs of one path, in order. Every user runs the path once with every option filled (the "full" run: required
// options and optional ones, the first choice where there are choices). In the approved guild the owner and the
// member also run it with the required options only, when it has optional ones, so the defaults are used too, and
// once for every other choice of every option, with the rest as in the full run, so each record type of /economy
// audit and so on is reached. Every game of /board start is started by the owner and by the member, each game in a
// channel of its own, so no game is refused because another one holds the channel.
//
// The long-data pass plans the same runs for the owner and the member, with free text at its longest and lists at
// their largest (test/support/slashCommandSweep.js, buildOptionValues), and the other choices for the owner only.
// Direct messages are left out of that pass: they answer before any data is read.
function plannedRuns(entry, { longData = false } = {}) {
  const plans = [];
  const hasOptional = entry.options.some((option) => !option.required);
  const suffix = longData ? LONG_DATA : '';
  const variant = longData ? 'longest' : 'full';
  for (const actor of ACTORS) {
    if (actor.guild === null && (longData || !runsInDirectMessages(entry))) continue;
    plans.push({ actor, variant, label: `${actor.key}${suffix}`, overrides: {} });
    if (hasOptional) {
      plans.push({
        actor, variant: longData ? 'longest-required' : 'required', label: `${actor.key}, required options only${suffix}`,
        overrides: {},
      });
    }
    if (!(actor.key === 'owner' || (actor.key === 'member' && !longData))) continue;
    for (const option of entry.options) {
      const everyGame = entry.key === 'board start' && option.name === 'game';
      for (const choice of everyGame ? option.choices : (option.choices || []).slice(1)) {
        const overrides = { [option.name]: choice.value };
        if (everyGame && CASINO_CHOICES[choice.value]) overrides.choice = CASINO_CHOICES[choice.value];
        plans.push({
          actor, variant, label: `${actor.key}, ${option.name}=${choice.value}${suffix}`, overrides,
          channel: everyGame ? `board ${actor.key} ${choice.value}` : null,
        });
      }
    }
  }
  if (!longData) {
    for (const extra of EXTRA_RUNS[entry.key] || []) {
      plans.push({ actor: ACTORS.find((actor) => actor.key === extra.actor), variant: 'full', label: extra.label,
        overrides: extra.overrides });
    }
  }
  return plans;
}

// What a run of `entry` must come out as, from the catalog's audience of the path and the user, unless
// RUN_EXCEPTIONS says otherwise: the categories it may have and, when it is refused, the kinds of refusal it may get.
function expectationFor(entry, plan) {
  const exception = RUN_EXCEPTIONS[`${entry.key}|${plan.label}`];
  if (exception) return { categories: exception.expect, refusals: null };
  const restricted = audienceOf(entry) !== 'public';
  switch (plan.actor.key) {
    case 'owner':
      return { categories: ['ok', 'offline-unavailable'], refusals: null };
    case 'member':
      return restricted
        ? { categories: ['denied'], refusals: ['permission', 'owner'] }
        : { categories: ['ok', 'offline-unavailable'], refusals: null };
    case 'direct-message':
      return restricted
        ? { categories: ['denied'], refusals: null }
        : { categories: ['ok', 'offline-unavailable', 'denied'], refusals: ['guild-only'] };
    default:
      throw new Error(`no expectation for ${plan.actor.key}`);
  }
}

function assertExpected(entry, plan, result) {
  const expected = expectationFor(entry, plan);
  assert.ok(expected.categories.includes(result.category),
    `${describeResult(result)}\n  expected: ${expected.categories.join(' or ')}`);
  if (result.category === 'denied' && expected.refusals) {
    assert.ok(expected.refusals.includes(result.refusal),
      `${describeResult(result)}\n  expected a refusal for ${expected.refusals.join(' or ')}, got ${result.refusal}`);
  }
}

// Sends `interaction` through the handler as `run`, and judges the run with what it changed (stateTracker: the
// state is marked before the run begins, so the mark's own reads are not the run's). `judging` gives the options of
// classifyRun once the run is over.
async function execute(run, interaction, mark, judging) {
  try {
    await interactionCreate.execute(interaction);
  } catch (error) {
    run.thrown = error;
  }
  await sweep.settle();
  sweep.finishRun(run);
  const changes = await stateTracker.changesSince(mark);
  return sweep.classifyRun(run, { ...judging(), changes });
}

async function runPath(entry, plan, { report = true } = {}) {
  const { actor } = plan;
  runCount += 1;
  test.mock.timers.setTime(SWEEP_START + runCount * 1000);
  const guild = actor.guild === null ? null : world.guilds[actor.guild];
  const channel = plan.channel ? world.channelFor(plan.channel) : world.channels[actor.guild ?? 'direct'];
  const context = { world, guild, path: entry.key, items, itemIdFor, optionChannel: plan.channel ? channel : null };
  const values = sweep.buildOptionValues(entry, context, {
    variant: plan.variant, overrides: { ...PATH_OPTION_OVERRIDES[entry.key], ...plan.overrides },
  });
  const mark = await stateTracker.mark();
  const run = sweep.beginRun({
    path: entry.key, actor: actor.key, variant: plan.label, options: sweep.describeOptionValues(values),
  });
  const interaction = sweep.createChatInputInteraction(world, {
    run, user: world.users[actor.user], guild, channel, entry, values,
  });
  const result = await execute(run, interaction, mark, () => ({
    networkAllowed: NETWORK_COMMANDS.has(entry.commandName),
  }));
  if (report) results.push(result);
  return result;
}

function describeResult(result) {
  return [
    `${result.path} as ${result.variant}: ${result.category}${result.refusal ? ` (${result.refusal})` : ''}`,
    result.detail ? `detail: ${result.detail}` : null,
    result.error ? `error: ${result.error}${result.errorAt ? ` (${result.errorAt})` : ''}` : null,
    `answer: ${JSON.stringify(result.reply)}`,
    `options: ${JSON.stringify(result.options)}`,
  ].filter(Boolean).join('\n  ');
}

test.before(async () => {
  startedAt = performance.now();
  test.mock.timers.enable({ apis: ['Date'], now: SWEEP_START });
  await sweep.openSweepDatabase(environment);
  world = sweep.createSweepWorld({ commands, extensionHost });
  configureRuntimes(world.client);
  await seedEconomy();
  // Everything under the temporary root: the data root (JSON stores, admission files), the side-effect ledgers, the
  // turtle-soup corpus and the stand-in release. The coin database file is left to the write counters, which know
  // what was written table by table.
  stateTracker = sweep.createStateTracker({ roots: [environment.root], ignoredFiles: [environment.files.coinDatabase] });
  await stateTracker.watchNewTables();
});

test.after(async () => {
  try {
    const report = REPORT_PATH;
    if (report) {
      const totals = {};
      for (const result of [...results, ...componentResults, ...autocompleteResults]) {
        totals[result.category] = (totals[result.category] || 0) + 1;
      }
      fs.mkdirSync(path.dirname(path.resolve(report)), { recursive: true });
      fs.writeFileSync(report, `${JSON.stringify({
        paths: PATHS.length,
        sweptPaths: sweptPaths.size,
        runs: results.length,
        componentRuns: componentResults.length,
        autocompleteRuns: autocompleteResults.length,
        actors: ACTORS.map((actor) => actor.key),
        excluded: EXCLUDED_PATHS,
        knownDefects: KNOWN_DEFECTS,
        exceptions: RUN_EXCEPTIONS,
        totals,
        durationMs: Math.round(performance.now() - startedAt),
        // How often the state was marked, how long marking and comparing took in all, and how many files were read.
        stateTracking: stateTracker ? { ...stateTracker.stats } : null,
        knownComponentDefects: KNOWN_COMPONENT_DEFECTS,
        // What happened while no run was active: setup, restores, and anything a run left running.
        betweenRuns: {
          missing: sweep.tracker.orphan.missing,
          logs: sweep.tracker.orphan.logs.filter((entry) => entry.level !== 'info')
            .map((entry) => `${entry.level}: ${entry.message}`.slice(0, 200)),
          unhandled: sweep.tracker.orphan.unhandled.map(String),
          fetches: sweep.tracker.orphan.fetches,
        },
        results,
        componentResults,
        autocompleteResults,
      }, null, 2)}\n`);
    }
  } finally {
    test.mock.timers.reset();
    // The ledgers are SQLite files held open; they are closed before the temporary root is removed.
    if (publicSideEffects) await publicSideEffects.stop();
    configureChainReactionFence(null);
    configurePublicEffectAdapter({});
    await resetBoardRuntimeForTests();
    sweep.closeSweepDatabase();
    restoreRejections();
    restoreLogger();
    restoreFetch();
    restoreRandomness();
    sweep.removeSweepEnvironment(environment);
  }
});

test('the sweep lists exactly the paths of the public command catalog', () => {
  const catalogPaths = COMMAND_CATALOG.flatMap((entry) => (entry.subcommands.length === 0
    ? [entry.name]
    : entry.subcommands.map((subcommand) => `${entry.name} ${subcommand}`)));
  assert.deepEqual(PATHS.map((entry) => entry.key).sort(), [...catalogPaths].sort());
  const known = new Set(PATHS.map((entry) => entry.key));
  for (const excluded of Object.keys(EXCLUDED_PATHS)) {
    assert.ok(known.has(excluded), `excluded path /${excluded} must exist`);
    assert.ok(EXCLUDED_PATHS[excluded].trim().length > 0, `excluded path /${excluded} needs a reason`);
  }
  for (const [table, entries] of [['known defect', KNOWN_DEFECTS], ['exception', RUN_EXCEPTIONS]]) {
    for (const key of Object.keys(entries)) {
      const [commandPath, label] = key.split('|');
      assert.ok(known.has(commandPath), `${table} ${key} must name an existing path`);
      const entry = PATHS.find((candidate) => candidate.key === commandPath);
      const labels = [...plannedRuns(entry), ...plannedRuns(entry, { longData: true })].map((plan) => plan.label);
      assert.ok(labels.includes(label), `${table} ${key} must name a run of that path`);
    }
  }
  for (const key of [...Object.keys(PATH_OPTION_OVERRIDES), ...Object.keys(RESTORE_AFTER), ...Object.keys(EXTRA_RUNS),
    ...LONG_DATA_SEEDS.map((seed) => seed.path)]) {
    assert.ok(known.has(key), `/${key} named by the sweep must exist`);
  }
  for (const name of NETWORK_COMMANDS) assert.ok(commands.has(name), `/${name} may use the network and must exist`);
  const gameChoices = PATHS.find((entry) => entry.key === 'board start').options.find((option) => option.name === 'game').choices;
  assert.deepEqual(gameChoices.map((choice) => choice.value), GAME_CATALOG.map((game) => game.key));
});

// ---------------------------------------------------------------------------------------------------------
// The component pass
// ---------------------------------------------------------------------------------------------------------

// The messages whose buttons the pass presses: what the owner's runs left on screen, by the run that made it. A
// board or a personal game is pressed on the owner's own start, so the member presses as a guest and the owner as
// host. Every game that shows controls is here; the rest of /board start answers once, without components. Each
// source is driven right after the test of the path that made it (defineComponentTests), the way a user answers a
// panel soon after it appears: a blackjack hand, for one, is refunded once ten minutes have passed.
const COMPONENT_SOURCES = Object.freeze([
  ...['turtle-soup', 'chess', 'gomoku', 'go', 'checkers', 'xiangqi', 'tetris', 'number-match', 'sudoku',
    'casino-blackjack'].map((game) => Object.freeze({ path: 'board start', variant: `owner, game=${game}`, label: `board ${game}` })),
  // A lobby the member hosts, which the owner tries to close as a guest before its host closes it: the one way the
  // lobby's stop button is reached, since every other lobby is begun first.
  Object.freeze({ path: 'board start', variant: 'member, game=gomoku', label: 'board gomoku, lobby the member hosts',
    first: Object.freeze(['stop']), actors: Object.freeze(['owner', 'member']) }),
  Object.freeze({ path: 'poll', variant: 'owner', label: 'poll' }),
  Object.freeze({ path: 'coin-admin add', variant: 'owner', label: 'coin-admin add, user preview' }),
  Object.freeze({ path: 'coin-admin add', variant: 'owner, role preview', label: 'coin-admin add, role preview' }),
]);

// The order the controls are pressed in, lowest first: joining and starting before playing, playing before giving up.
// A control not named here comes after every named one but the last four. A source may put controls first.
const CONTROL_ORDER = Object.freeze([
  'join', 'begin',
  'act.ask', 'act.guess', 'act.move', 'act.place', 'act.claim-draw', 'act.propose-dead', 'act.resume-play',
  'act.confirm-dead', 'act.pass', 'act.offer-draw', 'act.decline-draw', 'act.accept-draw',
  'move.t', 'move.n', 'move.s', 'move.sb', 'refresh', 'status',
  'vote 0', 'vote 1', 'vote 2', 'vote 3', 'vote 4', 'hit', 'stand', 'confirm', 'cancel',
]);
const CONTROL_ORDER_LAST = Object.freeze(['act.resign', 'leave', 'stop', 'reveal']);
const MAX_PRESSES_PER_SOURCE = 32;

// The family and the control a custom ID names, without the parts that change as the game goes on (session and
// revision).
function controlOf(customId) {
  const parts = customId.split('|');
  if (customId.startsWith('board|1|') && parts.length === 5) return { family: 'board', control: parts[4] };
  if (customId.startsWith('solo|1|')) return { family: 'solo', control: parts.length === 5 ? parts[4] : parts.slice(2).join('|') };
  if (customId.startsWith('poll:')) return { family: 'poll', control: `vote ${customId.split(':')[2]}` };
  if (customId.startsWith('casino:blackjack:')) return { family: 'blackjack', control: customId.split(':')[2] };
  if (customId.startsWith('coin-admin|1|add|')) return { family: 'coin-admin', control: parts[3] };
  return { family: 'other', control: customId };
}

function controlRank(control, first = []) {
  if (first.includes(control)) return -1;
  const last = CONTROL_ORDER_LAST.indexOf(control);
  if (last >= 0) return CONTROL_ORDER.length + 1 + last;
  const named = CONTROL_ORDER.indexOf(control);
  return named >= 0 ? named : CONTROL_ORDER.length;
}

// Every control the public core can show, by family: the board's own buttons and every game control of
// src/systems/games/board/discord/boardControls.js, the personal games' buttons, blackjack, the poll's first two
// options (a poll has at least two) and the coin-admin preview. The pass has to press each of them, or the control is
// in CONTROLS_NOT_DRIVEN with the reason.
const CONTROL_INVENTORY = Object.freeze({
  board: Object.freeze(['join', 'leave', 'begin', 'stop', 'status', 'reveal',
    ...new Set(Object.values(BOARD_CONTROL_DEFINITIONS).flatMap((controls) => controls.map((control) => `act.${control.id}`)))]),
  solo: Object.freeze(['move.t', 'move.n', 'move.s', 'move.sb', 'refresh', 'menu', 'difficulty']),
  blackjack: Object.freeze(['hit', 'stand']),
  poll: Object.freeze(['vote 0', 'vote 1']),
  'coin-admin': Object.freeze(['confirm', 'cancel']),
});
const CONTROLS_NOT_DRIVEN = Object.freeze({
  'solo menu': 'the game menu select is only shown by the old /games menu, which no public slash command reaches now',
  'solo difficulty': 'the difficulty select follows that menu only; /board start takes the difficulty as an option',
});

// The text a user types into a modal field: by the field's custom ID, or the example its placeholder gives, or
// nothing for a field that may be left empty.
const MODAL_INPUT_VALUES = Object.freeze({
  input: '主角是不是用鑰匙開了門？',
  column: '5',
  rotation: '0',
  first: 'A1',
  second: 'B1',
  cell: 'A1',
  value: '5',
  cells: 'A1=5 B2=3',
});

function modalValues(modal) {
  return Object.fromEntries(modal.inputs.map((input) => [input.custom_id,
    MODAL_INPUT_VALUES[input.custom_id] ?? (input.required === false ? '' : input.placeholder ?? '掃描測試輸入')]));
}

// The user of the component pass besides the owner and the member: the outsider, a member of the guild who neither
// started nor joined any game and owns no panel (the target user). It tries every control the first time it shows,
// before the owner or the member presses it, and submits every modal before the user it was shown to does.
const OUTSIDER = Object.freeze({ key: 'outsider', user: 'target', guild: 'approved' });
// Controls the outsider leaves alone, by family or by "family control", with the reason: anyone may use them, and a
// use changes the game for good. Every other control, the board's status button included, is for the players of the
// game, the maker of the personal game or hand, or the owner of the panel (src/systems/games/board/discord/
// boardInteractionAdapter.js, assertSessionBoundary).
const OUTSIDER_LEAVES = Object.freeze({
  'board join': 'anyone may join an open lobby; the outsider would become a player',
  poll: 'anyone may vote in a poll; a vote is what the buttons are for',
});

function outsiderLeaves(family, control) {
  return Boolean(OUTSIDER_LEAVES[family] || OUTSIDER_LEAVES[`${family} ${control}`]);
}

// Defects of the component pass that are reported and not fixed yet, by "source > control|user" (with " (modal)"
// after the control for a modal submission), with the reason. Each such press is a todo test: it still runs and is
// still checked, and it starts to pass once the defect is fixed.
const KNOWN_COMPONENT_DEFECTS = Object.freeze({});

// What a press may come out as, by who presses:
//   outsider    a refusal because the control is someone else's (the game's host or players, the maker of the
//               personal game or the hand; the owner, for the coin-admin preview), with nothing changed beyond
//               REFUSAL_MAY_CHANGE; a control that opens a modal may open it, and the submission is refused;
//   member      the owner refusal on the coin-admin preview (Discord shows an ephemeral message to its recipient
//               only, so the member's press is the command's own owner check at work); elsewhere an answer, or a
//               refusal while the game is someone else's (before joining, a host-only control, the owner's personal
//               game or hand);
//   owner       an answer, or a refusal on the lobby the member hosts.
function componentExpectation(family, actorKey, { modal = false } = {}) {
  if (actorKey === OUTSIDER.key) {
    return { categories: ['denied'], refusals: family === 'coin-admin' ? ['owner'] : ['not-yours'], modalAllowed: !modal };
  }
  if (family === 'coin-admin' && actorKey === 'member') return { categories: ['denied'], refusals: ['owner'] };
  return { categories: ['ok', 'denied'], refusals: ['not-yours'] };
}

// Presses `component` on the source message (or submits `modal`, shown by a press of it) as `actor`.
async function runComponent(source, { actor, family, control, component, modal = null }) {
  runCount += 1;
  test.mock.timers.setTime(SWEEP_START + runCount * 1000);
  const guild = world.guilds[actor.guild];
  const channel = actor.guild === 'approved' ? source.channel : world.channels[actor.guild];
  const user = world.users[actor.user];
  const label = modal ? `${control} (modal)` : control;
  const messageBefore = JSON.stringify(world.stateOf(source.message));
  const mark = await stateTracker.mark();
  const run = sweep.beginRun({ path: `${source.label} > ${label}`, actor: actor.key, variant: `${actor.key}, ${label}`,
    options: modal ? modalValues(modal) : { customId: component.custom_id } });
  const interaction = modal
    ? sweep.createModalSubmitInteraction(world, { run, user, guild, channel, message: source.message,
      modal, fieldValues: modalValues(modal) })
    : sweep.createComponentInteraction(world, { run, user, guild, channel, message: source.message,
      component, values: component.type === 3 ? [component.options?.[0]?.value].filter(Boolean) : [] });
  const result = await execute(run, interaction, mark, () => ({
    networkAllowed: false,
    sourceMessageChanged: JSON.stringify(world.stateOf(source.message)) !== messageBefore,
  }));
  Object.assign(result, { kind: modal ? 'modal' : 'component', family, control });
  componentResults.push(result);
  return { result, modals: run.modals };
}

function assertComponentExpected(family, actorKey, result, options) {
  const expected = componentExpectation(family, actorKey, options);
  // A control that opens a modal may open it for anyone, and must change nothing doing so: what the outsider is
  // refused is the submission.
  const openedModal = Boolean(expected.modalAllowed) && result.category === 'ok' && result.answers.join() === 'showModal';
  assert.ok(openedModal || expected.categories.includes(result.category),
    `${describeResult(result)}\n  expected: ${expected.categories.join(' or ')}`);
  if (result.category === 'denied' && expected.refusals) {
    assert.ok(expected.refusals.includes(result.refusal),
      `${describeResult(result)}\n  expected a refusal for ${expected.refusals.join(' or ')}, got ${result.refusal}`);
  }
  if (openedModal) {
    assert.deepEqual(sweep.changesBeyond(result, sweep.REFUSAL_MAY_CHANGE), [], `${describeResult(result)}\n  changed what it must not`);
  }
}

function defineComponentTests(pathKey) {
  for (const sourceRun of COMPONENT_SOURCES.filter((source) => source.path === pathKey)) defineComponentTest(sourceRun);
}

// Presses `next` (or submits `modal`, shown by a press of it) as `actor`, as a subtest of `t` named `name`, and checks
// the answer with assertComponentExpected; a modal the press shows is submitted by the same user right after. A
// press of KNOWN_COMPONENT_DEFECTS is a todo test.
async function pressAs(t, name, source, next, actor, modal = null) {
  const todo = KNOWN_COMPONENT_DEFECTS[`${source.label} > ${next.control}${modal ? ' (modal)' : ''}|${actor.key}`];
  await t.test(name, todo ? { todo } : {}, async () => {
    const { result, modals } = await runComponent(source, { ...next, actor, modal });
    assertComponentExpected(next.family, actor.key, result, { modal: Boolean(modal) });
    for (const shown of modals) {
      const submitted = await runComponent(source, { ...next, actor, modal: shown });
      assertComponentExpected(next.family, actor.key, submitted.result, { modal: true });
    }
  });
}

// The outsider, unless OUTSIDER_LEAVES names the control, presses `next` (or submits its modal) as a subtest of `t`.
async function tryAsOthers(t, source, next, modal = null) {
  const what = modal ? `submits the modal of ${next.control}` : `presses ${next.control}`;
  if (!outsiderLeaves(next.family, next.control)) await pressAs(t, `the outsider ${what}`, source, next, OUTSIDER, modal);
}

function defineComponentTest(sourceRun) {
  test(`components: ${sourceRun.label}`, async (t) => {
    const entry = world.messages.find((candidate) => candidate.origin?.path === sourceRun.path &&
      candidate.origin.variant === sourceRun.variant && sweep.componentsOf(world, candidate.message).length > 0);
    assert.ok(entry, `/${sourceRun.path} as ${sourceRun.variant} left a message with components`);
    const source = { ...sourceRun, message: entry.message, channel: entry.channel };
    // The guest presses first by default, so a host-only control is tried by someone it refuses before its host
    // uses it.
    const actors = (sourceRun.actors || ['member', 'owner']).map((key) => ACTORS.find((actor) => actor.key === key));
    const pressed = new Set();
    // The controls and the modals the outsider has tried on this message.
    const tried = new Set();
    let presses = 0;
    // Each press takes the most urgent control the message shows now that this user has not pressed yet; the
    // message changes as the game goes on, so the controls are read again before every press.
    while (presses < MAX_PRESSES_PER_SOURCE) {
      const candidates = sweep.componentsOf(world, source.message)
        .filter((component) => component.disabled !== true)
        .map((component) => ({ component, ...controlOf(component.custom_id) }))
        .sort((left, right) => controlRank(left.control, sourceRun.first) - controlRank(right.control, sourceRun.first));
      let next = null;
      for (const candidate of candidates) {
        const actor = actors.find((candidateActor) => !pressed.has(`${candidateActor.key}|${candidate.control}`));
        if (actor) {
          next = { ...candidate, actor };
          break;
        }
      }
      if (!next) break;
      if (!tried.has(next.control)) {
        tried.add(next.control);
        await tryAsOthers(t, source, next);
      }
      pressed.add(`${next.actor.key}|${next.control}`);
      presses += 1;
      await t.test(`${next.actor.key} presses ${next.control}`, async (pressTest) => {
        const { result, modals } = await runComponent(source, next);
        assertComponentExpected(next.family, next.actor.key, result);
        for (const modal of modals) {
          if (!tried.has(`${next.control} (modal)`)) {
            tried.add(`${next.control} (modal)`);
            await tryAsOthers(pressTest, source, next, modal);
          }
          const submitted = await runComponent(source, { ...next, modal });
          assertComponentExpected(next.family, next.actor.key, submitted.result);
        }
      });
    }
    for (const actor of actors) {
      assert.ok([...pressed].some((key) => key.startsWith(`${actor.key}|`)), `the ${actor.key} pressed a control of ${sourceRun.label}`);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------
// The first pass
// ---------------------------------------------------------------------------------------------------------

const sweptActors = new Map();

for (const entry of PATHS) {
  const excluded = EXCLUDED_PATHS[entry.key];
  test(`/${entry.key}`, excluded ? { skip: excluded } : {}, async (t) => {
    const actors = new Set();
    for (const plan of plannedRuns(entry)) {
      const todo = KNOWN_DEFECTS[`${entry.key}|${plan.label}`];
      await t.test(plan.label, todo ? { todo } : {}, async () => {
        const result = await runPath(entry, plan);
        actors.add(plan.actor.key);
        assertExpected(entry, plan, result);
      });
    }
    sweptPaths.add(entry.key);
    sweptActors.set(entry.key, actors);
    if (RESTORE_AFTER[entry.key]) {
      await RESTORE_AFTER[entry.key]();
      stateTracker.forgetFiles();
    }
  });
  defineComponentTests(entry.key);
}

test('every path that is not excluded was swept by every user', () => {
  const catalogPathCount = COMMAND_CATALOG.reduce((sum, entry) => sum + Math.max(entry.subcommands.length, 1), 0);
  const excludedCount = Object.keys(EXCLUDED_PATHS).length;
  assert.ok(sweptPaths.size >= catalogPathCount - excludedCount,
    `swept ${sweptPaths.size} paths, the catalog has ${catalogPathCount} and ${excludedCount} are excluded`);
  for (const [commandPath, actors] of sweptActors) {
    const entry = PATHS.find((candidate) => candidate.key === commandPath);
    const expected = runsInDirectMessages(entry) ? [...EVERY_PATH_ACTORS, 'direct-message'] : [...EVERY_PATH_ACTORS];
    assert.deepEqual([...actors].sort(), expected.sort(), `/${commandPath} was run by every user`);
  }
});

test('every game of /board start really starts, for the owner and for the member', () => {
  for (const actor of ['owner', 'member']) {
    for (const game of GAME_CATALOG) {
      const label = `${actor}, game=${game.key}`;
      const result = results.find((candidate) => candidate.path === '/board start' && candidate.variant === label);
      assert.ok(result, `/board start ran as ${label}`);
      if (RUN_EXCEPTIONS[`board start|${label}`]) continue;
      assert.ok(GAME_LAUNCHED[game.launcher](result), `/board start as ${label} started the game\n  ${describeResult(result)}`);
    }
  }
});

// Every source was pressed by both users (see defineComponentTest). A control that ends the game, such as resign,
// can only be used once, so each control has to be pressed by at least one of them.
test('the component pass pressed every control the public core shows and submitted the modals', () => {
  const pressed = new Set(componentResults.map((result) => `${result.family} ${result.control}`));
  for (const [family, controls] of Object.entries(CONTROL_INVENTORY)) {
    for (const control of controls) {
      const key = `${family} ${control}`;
      if (CONTROLS_NOT_DRIVEN[key]) {
        assert.ok(!pressed.has(key), `${key} was pressed, so it no longer belongs in CONTROLS_NOT_DRIVEN`);
        continue;
      }
      assert.ok(pressed.has(key), `${key} was pressed`);
    }
  }
  assert.ok(componentResults.some((result) => result.kind === 'modal'), 'a modal was submitted');
  for (const result of componentResults) {
    assert.ok(Object.hasOwn(CONTROL_INVENTORY, result.family), `${result.path} belongs to a known control family`);
  }
});

// Every control the owner or the member pressed and every modal they submitted was tried first by the outsider, unless
// OUTSIDER_LEAVES names it.
test('the outsider tried every control and modal first', () => {
  const keyOf = (result) => `${result.kind} ${result.family} ${result.control}`;
  const triedBy = (actor) => new Set(componentResults.filter((result) => result.actor === actor.key).map(keyOf));
  const outsider = triedBy(OUTSIDER);
  for (const result of componentResults.filter((candidate) => candidate.actor === 'owner' || candidate.actor === 'member')) {
    if (outsiderLeaves(result.family, result.control)) continue;
    assert.ok(outsider.has(keyOf(result)), `${keyOf(result)} was tried by the outsider`);
  }
  for (const key of Object.keys(OUTSIDER_LEAVES)) {
    assert.ok(componentResults.some((result) => result.family === key || `${result.family} ${result.control}` === key),
      `${key}, which the outsider leaves alone, was pressed`);
  }
  for (const key of Object.keys(KNOWN_COMPONENT_DEFECTS)) {
    const [press, actor] = key.split('|');
    assert.ok(componentResults.some((result) => result.path === `/${press}` && result.actor === actor),
      `known component defect ${key} must name a press of the component pass`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The autocomplete pass
// ---------------------------------------------------------------------------------------------------------

// Every option a command suggests values for while the user types it (setAutocomplete), by path.
const AUTOCOMPLETE_OPTIONS = Object.freeze(PATHS.flatMap((entry) => entry.options
  .filter((option) => option.autocomplete === true)
  .map((option) => Object.freeze({ entry, option }))));
// What the user has typed into the option so far: nothing, a letter, and text at the longest an option takes.
const AUTOCOMPLETE_QUERIES = Object.freeze(['', 'b', '掃描長文字測試，'.repeat(13).slice(0, 100)]);

// The other options typed before the focused one, as Discord sends them during autocomplete: nothing yet, or one
// choice of a required option with choices (each choice in turn), so the suggestions of every game are asked for.
function typedBefore(entry, focused) {
  const states = [[]];
  for (const option of entry.options) {
    if (option === focused || !option.required || !option.choices) continue;
    for (const choice of option.choices) states.push([{ name: option.name, type: option.type, value: choice.value }]);
  }
  return states;
}

async function runAutocomplete(entry, option, { actor, typed, query }, { report = true } = {}) {
  runCount += 1;
  test.mock.timers.setTime(SWEEP_START + runCount * 1000);
  const guild = actor.guild === null ? null : world.guilds[actor.guild];
  const channel = world.channels[actor.guild ?? 'direct'];
  const values = [...typed, { name: option.name, type: option.type, value: query, focused: true }];
  const typedLabel = typed.map((value) => `${value.name}=${value.value}`).join(', ') || 'nothing typed';
  const label = `${actor.key}, ${typedLabel}, ${option.name}=${JSON.stringify(query.slice(0, 12))}${query.length > 12 ? '…' : ''}`;
  const mark = await stateTracker.mark();
  const run = sweep.beginRun({ path: `${entry.key} (autocomplete ${option.name})`, actor: actor.key, variant: label,
    options: Object.fromEntries(values.map((value) => [value.name, value.value])), kind: 'autocomplete' });
  const interaction = sweep.createAutocompleteInteraction(world, {
    run, user: world.users[actor.user], guild, channel, entry, values,
  });
  const result = await execute(run, interaction, mark, () => ({}));
  result.kind = 'autocomplete';
  if (report) autocompleteResults.push(result);
  return result;
}

// The owner and the member get a suggestion list Discord accepts for everything they may have typed. A suggestion
// changes nothing, whoever asks: interactionCreate does not even count it.
for (const { entry, option } of AUTOCOMPLETE_OPTIONS) {
  test(`autocomplete: /${entry.key} ${option.name}`, async (t) => {
    const actors = ACTORS.filter((actor) => actor.guild !== null || runsInDirectMessages(entry));
    for (const actor of actors) {
      for (const typed of typedBefore(entry, option)) {
        for (const query of AUTOCOMPLETE_QUERIES) {
          await t.test(`${actor.key}, ${typed.map((value) => value.value).join(', ') || 'nothing typed'}, ${JSON.stringify(query.slice(0, 12))}`, async () => {
            const result = await runAutocomplete(entry, option, { actor, typed, query });
            assert.equal(result.category, 'ok', describeResult(result));
            assert.deepEqual(sweep.changesBeyond(result, {}), [], `${describeResult(result)}\n  a suggestion changed something`);
          });
        }
      }
    }
  });
}

// The suggestions match the game: the bets of each casino game that takes one (the sweep's own bet among them), and
// none for the other games.
test('autocomplete suggests the bets of the game typed, and the sweep bets with one of them', () => {
  assert.ok(AUTOCOMPLETE_OPTIONS.length > 0, 'a public command suggests values');
  for (const game of GAME_CATALOG) {
    for (const actor of ['owner', 'member']) {
      const result = autocompleteResults.find((candidate) => candidate.actor === actor &&
        candidate.options.game === game.key && candidate.options.choice === '');
      assert.ok(result, `/board start suggested choices to the ${actor} for ${game.key}`);
      if (CASINO_CHOICES[game.key]) {
        assert.ok(result.choices.includes(CASINO_CHOICES[game.key]), `${describeResult(result)}\n  suggests ${CASINO_CHOICES[game.key]}`);
      } else {
        assert.deepEqual(result.choices, [], `${describeResult(result)}\n  suggests nothing for ${game.key}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------------------
// The long-data pass
// ---------------------------------------------------------------------------------------------------------

for (const seed of LONG_DATA_SEEDS) {
  const entry = PATHS.find((candidate) => candidate.key === seed.path);
  const actor = ACTORS.find((candidate) => candidate.key === seed.actor);
  test(`long data: /${seed.path} ${LONG_DATA_COPIES} times as ${seed.actor}`, async (t) => {
    for (let copy = 1; copy <= LONG_DATA_COPIES; copy += 1) {
      const label = `${seed.actor}, copy ${copy}${LONG_DATA}`;
      await t.test(label, async () => {
        const plan = { actor, variant: 'longest', label, overrides: {} };
        const result = await runPath(entry, plan);
        assertExpected(entry, plan, result);
      });
    }
  });
}

test(`long data: ${LONG_ITEM_COUNT} items with the longest name and description bought, owned and pawned, and work submitted`, async () => {
  const guildId = IDS.approvedGuild;
  const name = (index) => `${String(index).padStart(2, '0')}${LONG_ITEM_NAME}`.slice(0, 80);
  const description = '掃描長文字測試，'.repeat(63).slice(0, 500);
  // The first pass has spent and reset wallets (/coin-admin set, remove and reset-user), so both are filled again.
  for (const userId of [IDS.member, IDS.target]) {
    await coinService.adjustPlayerBalance(guildId, userId, {
      action: 'add', amount: 1_000_000, operatorId: IDS.owner, reason: '掃描測試長資料補充資金',
      operationId: `sweep-long-data-funds-${userId}`,
    });
  }
  const shopItems = [];
  const luxuryItems = [];
  for (let index = 1; index <= LONG_ITEM_COUNT; index += 1) {
    // Every fourth item is a battle item, which /duel-tower weapons lists.
    shopItems.push(await coinService.createShopItem(guildId, {
      name: name(index), price: 10, type: index % 4 === 0 ? 'battle_item' : 'collectible', description, createdBy: IDS.owner,
    }));
    luxuryItems.push(await luxuryService.createLuxuryItem(guildId, {
      name: name(index), price: 100, description, createdBy: IDS.owner,
    }));
  }
  for (const [position, item] of shopItems.entries()) {
    await coinService.purchaseItem(guildId, IDS.member, item.id, 1);
    if (position % 2 === 0) await coinService.purchaseItem(guildId, IDS.target, item.id, 1);
  }
  for (const [position, item] of luxuryItems.entries()) {
    await luxuryService.purchaseLuxuryItem(guildId, IDS.member, item.id, 1);
    if (position % 2 === 0) await luxuryService.pawnLuxuryItem(guildId, IDS.member, item.id, 1);
  }
  for (let copy = 1; copy <= LONG_DATA_COPIES; copy += 1) {
    await bankService.createFixedDeposit(guildId, IDS.target, { amount: 1000 * copy, termDays: 30, source: 'wallet' });
  }
  assert.equal(shopItems.length, LONG_ITEM_COUNT);

  // Work tasks need an active job, and a job selected now only starts at the next pay boundary: the clock is moved
  // three days on, the due activations are run the way the scheduler runs them, and the work is then submitted and
  // assigned. The next run puts the clock back (runPath).
  const workers = [IDS.member, IDS.target];
  for (const userId of workers) {
    try {
      await workService.startJob(guildId, userId, workService.JOB_TYPES[0].name, 1);
    } catch (error) {
      // The first pass chose a job for the member already.
      if (error?.code !== 'PRIMARY_JOB_EXISTS') throw error;
    }
  }
  test.mock.timers.setTime(Date.now() + 3 * 86_400_000);
  await workService.processDueJobs(null);
  const longText = '掃描長文字測試，'.repeat(130).slice(0, 1000);
  for (const userId of workers) {
    const { activePrimaryJob } = await workService.getWorkStatus(guildId, userId);
    assert.ok(activePrimaryJob, `the selected job of ${userId} is active`);
    const { reportChannelName } = workService.JOB_TYPES.find((item) => item.name === activePrimaryJob.jobName);
    for (let copy = 1; copy <= LONG_DATA_COPIES; copy += 1) {
      await workService.reportWork(guildId, userId, {
        taskType: '掃描長文字測試任務'.repeat(12).slice(0, 80), description: longText, channelName: reportChannelName,
      });
    }
    for (let copy = 1; copy <= 5; copy += 1) {
      await workService.addPendingTask(guildId, userId, { taskType: '掃描測試指派', description: longText.slice(0, 500), dueHours: 10 });
    }
  }
  stateTracker.forgetFiles();
});

for (const entry of PATHS) {
  if (EXCLUDED_PATHS[entry.key]) continue;
  test(`/${entry.key}${LONG_DATA}`, async (t) => {
    for (const plan of plannedRuns(entry, { longData: true })) {
      const todo = KNOWN_DEFECTS[`${entry.key}|${plan.label}`];
      await t.test(plan.label, todo ? { todo } : {}, async () => {
        const result = await runPath(entry, plan);
        assertExpected(entry, plan, result);
      });
    }
    if (RESTORE_AFTER[entry.key]) {
      await RESTORE_AFTER[entry.key]();
      stateTracker.forgetFiles();
    }
  });
}

// The long-data pass only tests the length of a list while its data is long enough to reach Discord's limit. These
// are the lists a member's text or a row count can make too long; if the seeds stop filling one of them (a seed
// refused, an item gone), that list is no longer tested by this pass and the sweep says so.
const LISTS_FILLED_BY_LONG_DATA = Object.freeze([
  'shop list', 'shop purchases', 'shop purchases-all', 'luxury list', 'luxury history', 'remind list', 'bank fixed-all',
  'economy audit', 'work status-user', 'work submissions', 'work tasks', 'work tasks-all', 'work pending', 'pawn active',
  'pawn history', 'inventory',
]);
const FILLED_LENGTH = 1500;

test('the long data filled the lists that can pass the limit', () => {
  for (const commandPath of LISTS_FILLED_BY_LONG_DATA) {
    const longest = Math.max(0, ...results
      .filter((result) => result.path === `/${commandPath}` && result.variant.includes(LONG_DATA))
      .map((result) => result.replyLength));
    assert.ok(longest >= FILLED_LENGTH, `/${commandPath} answered at most ${longest} characters in the long-data pass`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The checks themselves
// ---------------------------------------------------------------------------------------------------------

// Commands that are broken on purpose, one for each kind of failure, and a few that are fine but look close to one,
// run the same way as the real ones. A sweep whose checks stopped noticing a failure would otherwise pass without
// having looked.
const PROBES = Object.freeze([
  ['throws', 'command-failed', async () => { throw new TypeError('synthetic probe failure'); }],
  ['never answers', 'no-response', async () => {}],
  ['defers and never answers', 'no-response', async (interaction) => { await interaction.deferReply(); }],
  ['answers twice', 'protocol-violation', async (interaction) => {
    await interaction.reply('第一次回覆');
    await interaction.reply('第二次回覆');
  }],
  ['shows a missing value', 'bad-content', async (interaction) => { await interaction.reply(`餘額：${undefined}`); }],
  ['answers past 2000 characters', 'bad-content', async (interaction) => { await interaction.reply('長'.repeat(2001)); }],
  ['sends an empty message', 'bad-content', async (interaction) => { await interaction.reply({ content: '' }); }],
  ['hides its own failure', 'internal-error', async (interaction) => {
    await interaction.reply({ content: '探針剛剛執行失敗了，請稍後再試。', ephemeral: true });
  }],
  ['answers with any failure phrase', 'internal-error', async (interaction) => {
    await interaction.reply({ content: '活動操作暫時無法完成，請稍後重試。', ephemeral: true });
  }],
  ['logs a fault and answers', 'internal-error', async (interaction) => {
    logger.error('/sweep-probe failed quietly', new TypeError('synthetic probe fault'));
    await interaction.reply({ content: '已完成。', ephemeral: true });
  }],
  ['logs a caught failure of a subcommand as a warning and answers kindly', 'internal-error', async (interaction) => {
    logger.warn('/sweep-probe word-chain failed: SYNTHETIC_PROBE_CODE');
    await interaction.reply({ content: '已處理。', ephemeral: true });
  }],
  ['logs another warning and answers kindly', 'internal-error', async (interaction) => {
    logger.warn('[SWEEP_PROBE] store write skipped');
    await interaction.reply({ content: '已處理。', ephemeral: true });
  }],
  ['logs an error without its cause and answers kindly', 'internal-error', async (interaction) => {
    logger.error('sweep probe store write failed');
    await interaction.reply({ content: '已處理。', ephemeral: true });
  }],
  ['logs an error with a code that is not a refusal and answers kindly', 'internal-error', async (interaction) => {
    logger.error('sweep probe lookup', Object.assign(new Error('synthetic unknown code'), { code: 'SWEEP_PROBE_UNLISTED' }));
    await interaction.reply({ content: '已處理。', ephemeral: true });
  }],
  ['logs an integrity error and answers kindly', 'internal-error', async (interaction) => {
    logger.error('sweep probe receipt check failed', Object.assign(new Error('synthetic corrupt receipt'), { code: 'RECEIPT_CORRUPT' }));
    await interaction.reply({ content: '這一局已處理。', ephemeral: true });
  }],
  ['reaches the network', 'unexpected-network', async (interaction) => {
    await fetch('https://sweep-probe.invalid/');
    await interaction.reply({ content: '已完成。', ephemeral: true });
  }],
  ['reads what the fake lacks', 'fake-insufficient', async (interaction) => {
    await interaction.reply(`語系：${interaction.sweepProbeProperty}`);
  }],
  ['logs a refusal it explains', 'ok', async (interaction) => {
    logger.error('sweep probe refused', Object.assign(new Error('synthetic refusal'), { code: 'SESSION_NOT_FOUND' }));
    await interaction.reply({ content: '這個頻道目前沒有進行中的棋局。', ephemeral: true });
  }],
  ['gives a friendly refusal that uses a failure phrase', 'ok', async (interaction) => {
    await interaction.reply({ content: sweep.FRIENDLY_REFUSALS[0][0], ephemeral: true });
  }],
  ['refuses for a missing permission', 'denied', async (interaction) => {
    await interaction.reply({ content: '你需要 Administrator 權限才能使用 /sweep-probe。', ephemeral: true });
  }],
  ['refuses after paying out', 'changed-on-refusal', async (interaction) => {
    await coinService.adjustPlayerBalance(IDS.approvedGuild, IDS.target, {
      action: 'add', amount: 1, operatorId: IDS.owner, reason: '掃描測試探針', operationId: 'sweep-probe-refusal-payout',
    });
    await interaction.reply({ content: '你需要 Administrator 權限才能使用 /sweep-probe。', ephemeral: true });
  }],
  ['refuses after posting in the channel', 'changed-on-refusal', async (interaction) => {
    await interaction.channel.send('探針公告');
    await interaction.reply({ content: '你需要 Administrator 權限才能使用 /sweep-probe。', ephemeral: true });
  }],
  ['refuses after changing a stored file', 'changed-on-refusal', async (interaction) => {
    fs.writeFileSync(path.join(environment.dataRoot, 'sweep-probe.json'), '{}\n');
    await interaction.reply({ content: '你需要 Administrator 權限才能使用 /sweep-probe。', ephemeral: true });
  }],
]);

test('the checks of the sweep notice each kind of failure', async (t) => {
  const owner = ACTORS.find((actor) => actor.key === 'owner');
  for (const [description, expected, execute] of PROBES) {
    await t.test(description, async () => {
      const name = 'sweep-probe';
      commands.set(name, { data: { name }, execute });
      try {
        const entry = { key: name, commandName: name, group: null, subcommand: null, options: [] };
        const result = await runPath(entry, { actor: owner, variant: 'full', label: `owner, probe ${description}`, overrides: {} },
          { report: false });
        assert.equal(result.category, expected, describeResult(result));
      } finally {
        commands.delete(name);
      }
    });
  }
});

// Autocomplete handlers broken on purpose, judged like the real one: [description, category, handler, whether the
// run changed something].
const AUTOCOMPLETE_PROBES = Object.freeze([
  ['suggests what Discord takes', 'ok', async (interaction) => {
    await interaction.respond([{ name: '探針選項', value: 'probe' }]);
  }, false],
  ['suggests 26 choices', 'bad-content', async (interaction) => {
    await interaction.respond(Array.from({ length: 26 }, (_, index) => ({ name: `選項 ${index}`, value: `choice-${index}` })));
  }, false],
  ['suggests a name past 100 characters', 'bad-content', async (interaction) => {
    await interaction.respond([{ name: '長'.repeat(101), value: 'long' }]);
  }, false],
  ['suggests a missing value', 'bad-content', async (interaction) => {
    await interaction.respond([{ name: `選項 ${undefined}`, value: 'missing' }]);
  }, false],
  ['never responds', 'no-response', async () => {}, false],
  ['responds twice', 'protocol-violation', async (interaction) => {
    await interaction.respond([]);
    await interaction.respond([]);
  }, false],
  ['throws', 'internal-error', async () => { throw new TypeError('synthetic autocomplete probe failure'); }, false],
  ['writes while it suggests', 'ok', async (interaction) => {
    await coinService.adjustPlayerBalance(IDS.approvedGuild, IDS.target, {
      action: 'add', amount: 1, operatorId: IDS.owner, reason: '掃描測試探針', operationId: 'sweep-probe-autocomplete-write',
    });
    await interaction.respond([]);
  }, true],
]);

test('the checks of the sweep notice each kind of autocomplete failure', async (t) => {
  const owner = ACTORS.find((actor) => actor.key === 'owner');
  for (const [description, expected, autocomplete, changes] of AUTOCOMPLETE_PROBES) {
    await t.test(description, async () => {
      const name = 'sweep-probe';
      commands.set(name, { data: { name }, async execute() {}, autocomplete });
      try {
        const entry = { key: name, commandName: name, group: null, subcommand: null, options: [] };
        const option = { name: 'query', type: ApplicationCommandOptionType.String };
        const result = await runAutocomplete(entry, option, { actor: owner, typed: [], query: '' }, { report: false });
        assert.equal(result.category, expected, describeResult(result));
        assert.equal(sweep.changesBeyond(result, {}).length > 0, changes, describeResult(result));
      } finally {
        commands.delete(name);
      }
    });
  }
});

test('nothing reached the fake Discord or the network outside a run', (t) => {
  assert.deepEqual(sweep.tracker.orphan.missing, [], 'no fake was used outside a run');
  assert.deepEqual(sweep.tracker.orphan.unhandled, [], 'no promise was rejected unhandled between runs');
  assert.deepEqual(sweep.tracker.orphan.fetches, [], 'nothing reached the network between runs');
  t.diagnostic(`${results.length} command runs over ${sweptPaths.size} paths, ${componentResults.length} component runs `
    + `and ${autocompleteResults.length} autocomplete runs in ${Math.round(performance.now() - startedAt)} ms`);
});
