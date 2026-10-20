'use strict';

// A started bot in miniature, for the attack tests that go through the real interaction handler and the real event
// path (test/securityAttackPermissions.test.js, securityAttackReplay.test.js, securityAttackPublicText.test.js,
// securityAttackCommandValues.test.js and securityAttackMessageStorm.test.js).
//
// It is the fake Discord of the slash command sweep (test/support/slashCommandSweep.js) with the pieces an attack
// needs on top of it:
//   - two guilds the bot has been admitted to (home and away), so a panel of one can be replayed from the other.
//     The member and the target belong to both; the bot owner and a second administrator ("admin", who is not the
//     bot owner) belong to home; a third administrator ("awayAdmin") belongs to away;
//   - the real interaction handler (src/events/interactionCreate.js), the real commands and services and a real coin
//     database in a temporary directory. The board and solo game runtimes, the reward and work-role coordinators and
//     the public side-effect runtime are configured the way src/index.js configures them;
//   - the egress guard of the real bot (src/platform/egressGuard.js) in front of a synthetic REST: every answer a run
//     gives (reply, edit, follow-up, update, modal, channel message) is also turned into the request discord.js would
//     send, and sent through the guard, so a test can read what would really leave the process (outcome.wire);
//   - a state tracker (what a run wrote, table by table and file by file) and the checks every refusal has to meet;
//   - with liveEgress, the same guard and the egress limiter in the path of every channel message, reply and reaction
//     the bot sends on its own (a handler's channel.send, the side-effect runtimes), so a test of volume reads what the
//     limiter let through (session.wireLog) and a refused request throws the way the real client's does.
//
// Order of use in a test file:
//   1. require this file and call createAttackSession() before requiring anything under src: modules take their random
//      functions and their data paths while they load;
//   2. require the commands and services the test uses;
//   3. test.before(() => session.open()); test.after(() => session.close());
//   4. session.run / session.press / session.submit, and the assertions at the end of this file.
//
// Nothing here reaches the network: every fetch is answered 503, and nothing under src can name a path outside the
// temporary root.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mock } = require('node:test');
const { ComponentType, MessageFlags, MessagePayload, Options, PermissionFlagsBits } = require('discord.js');

const sweep = require('./slashCommandSweep');

const { IDS } = sweep;

// A fixed Monday noon in Taipei; every run moves the clock one second on.
const START_TIME = Date.parse('2026-03-02T04:00:00.000Z');
// Synthetic IDs of the users this session adds to the sweep's world. None belongs to a real account.
const EXTRA_IDS = Object.freeze({ admin: '760000000000000005' });
// The tag the egress guard of the real bot is built with (src/index.js uses `v${version}`).
const APPROVED_RELEASE_TAG = 'v1.1.2';
// Text a refused run may still change: the count of interactions interactionCreate keeps for every answered one.
const COUNTED_INTERACTION_TABLES = Object.freeze(['feature_usage_daily']);
// What the bot owner's refusal says, and the permission refusal of the moderation helper.
const OWNER_DENIED = '你沒有權限使用這個指令。';
const ADMIN_DENIED = /^你需要 Administrator 權限才能使用 \/[a-z-]+。$/u;

// The field names of an option given as a whole object (see raw()).
const RAW = Symbol('attackSession.raw');

// An option that replaces what the sweep would have generated for it. { value, user, member, channel, role } are
// delivered to the command as given; a field left out is left out of the option (an unresolved user, for one).
function raw(fields) {
  return Object.freeze({ [RAW]: true, ...fields });
}

function isRaw(value) {
  return Boolean(value && typeof value === 'object' && value[RAW] === true);
}

function textOfBody(body) {
  const parts = [];
  if (typeof body?.content === 'string') parts.push(body.content);
  for (const embed of body?.embeds || []) {
    for (const part of [embed?.title, embed?.description, embed?.footer?.text, embed?.author?.name,
      ...(embed?.fields || []).flatMap((field) => [field?.name, field?.value])]) {
      if (typeof part === 'string') parts.push(part);
    }
  }
  const visit = (component) => {
    for (const part of [component?.label, component?.placeholder, component?.content]) {
      if (typeof part === 'string') parts.push(part);
    }
    for (const child of component?.components || []) visit(child);
  };
  for (const component of body?.components || []) visit(component);
  return parts.join(' / ');
}

const ANSWER_METHODS = Object.freeze(['reply', 'editReply', 'followUp', 'update']);

// extensionHost: the host the commands are loaded through, or a function that makes it when the session opens (the
// session has to exist before anything under src is required, and a host carrying an extension requires a lot). The
// default is the public core alone (no extension); a test of the private extension passes one that carries it.
function createAttackSession({
  prefix = 'xiaoji-attack-session-', egressLimits = false, liveEgress = false, extensionHost: givenHost = null,
} = {}) {
  const restoreRandomness = sweep.installDeterministicRandomness();
  const environment = sweep.createSweepEnvironment(prefix);
  // Both guilds are admitted, so what an attack meets is the rule of the command and not the admission of the guild.
  fs.writeFileSync(environment.files.audit, `${JSON.stringify({
    [IDS.approvedGuild]: { guildId: IDS.approvedGuild, name: 'Attack Home Guild', status: 'approved' },
    [IDS.pendingGuild]: { guildId: IDS.pendingGuild, name: 'Attack Away Guild', status: 'approved' },
  }, null, 2)}\n`);
  const restoreFetch = sweep.installOfflineFetch();
  const restoreLogger = sweep.captureLogger();
  const restoreRejections = sweep.captureUnhandledRejections();

  let world = null;
  let commands = null;
  let tracker = null;
  let interactionCreate = null;
  let publicSideEffects = null;
  let guardedRest = null;
  let limiter = null;
  let publicEffectAuthority = null;
  // Every request that reached the transport of the guarded REST, in order, with the time (the session's clock).
  const wireLog = [];
  let runCount = 0;
  let extraChannelCount = 0;
  const paths = new Map();
  const wrappedChannels = new WeakSet();

  // -------------------------------------------------------------------------------------------------------
  // the side-effect runtime and the game runtimes, as src/index.js leaves them
  // -------------------------------------------------------------------------------------------------------

  function armPublicSideEffects() {
    const { createSyntheticRest } = require('../fixtures/syntheticRest');
    const { initializePublicLedgers, openPublicLedgers } = require('../fixtures/publicLedgers');
    const { createPublicEffectAuthority } = require('../../src/platform/publicEffectGrant');
    const { configurePublicEffectAdapter } = require('../../src/platform/publicEffectAdapter');
    const { configureChainReactionFence } = require('../../src/systems/safety/chainReactionFence');
    const { PublicSideEffectRuntime } = require('../../src/systems/safety/publicSideEffectRuntime');
    const logger = require('../../src/utils/logger');
    const ledgerRoot = path.join(environment.root, 'ledgers');
    fs.mkdirSync(ledgerRoot);
    const ledgers = initializePublicLedgers({ root: ledgerRoot, name: 'attack', botId: IDS.bot, cutover: START_TIME - 60_000 });
    const record = (method) => async (route) => {
      sweep.noteEffect({ kind: 'rest', method, route });
      return method === 'post' ? { id: `${IDS.bot.slice(0, -1)}7`, channel_id: route.split('/')[2] } : {};
    };
    // A session with live egress sends the runtime's own requests the way src/index.js does: through the guard, and
    // under the limiter.
    const rest = liveEgress ? guardedRest : createSyntheticRest({ get: record('get'), post: record('post'),
      put: record('put'), patch: record('patch'), delete: record('delete') });
    const authority = createPublicEffectAuthority();
    publicEffectAuthority = authority;
    const runtime = new PublicSideEffectRuntime({
      client: { rest }, botId: IDS.bot, logger, env: {}, now: () => Date.now(), effectAuthority: authority,
      ...(liveEgress ? { egressLimiter: limiter } : {}),
    });
    runtime.preflight({ ledgers: openPublicLedgers(ledgers, { botId: IDS.bot, now: () => Date.now() }) });
    runtime.arm();
    configurePublicEffectAdapter({
      publicEffectRuntime: runtime, publicEffectIssuer: authority.createIssuer(), publicEffectAuthority: authority,
    });
    configureChainReactionFence(runtime);
    return runtime;
  }

  function configureRuntimes(client) {
    const { configureBoardRuntime } = require('../../src/games/boardRuntimeRegistry');
    const { createBoardDiscordRuntime } = require('../../src/games/discord/boardDiscordRuntime');
    const { configureSoloRuntime } = require('../../src/systems/games/soloRuntimeRegistry');
    const { createDefaultSoloDiscordRuntime } = require('../../src/systems/games/soloDiscordRuntime');
    const { createRuntimeRewardCoordinator } = require('../../src/coordinators/rewardRuntime');
    const { configureWorkRewardCoordinator } = require('../../src/systems/work/workRewardPort');
    const { workRoleCoordinator } = require('../../src/coordinators/workRoleCoordinator');
    const { configureWorkRoleCoordinator } = require('../../src/systems/work/workRolePort');
    const { configureArchivePathResolver } = require('../../src/services/aiArchiveService');
    const { resolveDataPath } = require('../../src/platform/dataPaths');
    const logger = require('../../src/utils/logger');
    publicSideEffects = armPublicSideEffects();
    configureArchivePathResolver(resolveDataPath);
    client.boardRuntime = configureBoardRuntime(createBoardDiscordRuntime({ client }));
    const rewardCoordinator = createRuntimeRewardCoordinator();
    client.soloRuntime = configureSoloRuntime(createDefaultSoloDiscordRuntime({
      client, runtimeLogger: logger, rewardCoordinator,
    }));
    configureWorkRewardCoordinator(rewardCoordinator);
    configureWorkRoleCoordinator(workRoleCoordinator);
  }

  // -------------------------------------------------------------------------------------------------------
  // the egress guard in front of a synthetic REST
  // -------------------------------------------------------------------------------------------------------

  function installGuardedRest() {
    const { createSyntheticRest } = require('../fixtures/syntheticRest');
    const { installEgressGuard } = require('../../src/platform/egressGuard');
    let counter = 0;
    const nextId = () => String(900000000000000000n + BigInt(++counter));
    const keep = (method) => (route, request) => {
      wireLog.push({ at: Date.now(), method, route, body: request?.body ?? null, files: request?.files ?? [] });
      return method === 'DELETE' || /\/callback$/u.test(route) ? undefined : { id: nextId(), channel_id: IDS.approvedChannel };
    };
    // discord.js' own global limit (50 a second) is left out: it sleeps on the real clock until the clock it reads
    // (Date, which a test moves by hand) has moved, so a test that holds the time still would wait for ever. The
    // limits that are under test here are the bot's (egressLimiter), and they read the same Date.
    const rest = createSyntheticRest({ get: () => ({}), post: keep('POST'), patch: keep('PATCH'), put: keep('PUT'),
      delete: keep('DELETE') }, { globalRequestsPerSecond: Number.MAX_SAFE_INTEGER });
    const guard = installEgressGuard(rest, {
      approvedReleaseTag: APPROVED_RELEASE_TAG,
      privateGuildIds: [],
      resolveChannelGuild: (channelId) => world.client.channels.cache.get(channelId)?.guildId ?? null,
    });
    // src/index.js lets the limiter admit every request at the guard. A session that is about content leaves it
    // out, so a long loop is not refused for its pace; a session that is about volume asks for it.
    if (egressLimits || liveEgress) guard.setAdmission((details) => limiter.admit(details));
    return rest;
  }

  // The body discord.js would put on the wire for options a command gave to reply(), editReply(), send() and the like.
  async function resolveWireBody(options) {
    const given = typeof options === 'string' ? { content: options } : { ...options };
    // The target is only asked for the client's options and, for a reply, how a message reference is read.
    const target = {
      client: { options: Options.createDefault() },
      messages: { resolveId: (reference) => (typeof reference === 'string' ? reference : reference?.id ?? null) },
    };
    const payload = MessagePayload.create(target, given);
    payload.resolveBody();
    await payload.resolveFiles();
    const body = JSON.parse(JSON.stringify(payload.body));
    if (given.ephemeral) body.flags = (body.flags || 0) | MessageFlags.Ephemeral;
    return { body, files: payload.files };
  }

  // What a recorded answer is as a request: the method and route discord.js uses for it, and the body.
  async function requestOf(entry) {
    const { method, options, interaction, channelId } = entry;
    const callback = `/interactions/${interaction?.id}/${interaction?.token}/callback`;
    const original = `/webhooks/${interaction?.applicationId}/${interaction?.token}/messages/@original`;
    const followUp = `/webhooks/${interaction?.applicationId}/${interaction?.token}`;
    if (method === 'deferReply') {
      const flags = options?.ephemeral ? MessageFlags.Ephemeral : undefined;
      return { method: 'POST', fullRoute: callback, body: { type: 5, data: flags ? { flags } : {} } };
    }
    if (method === 'deferUpdate') return { method: 'POST', fullRoute: callback, body: { type: 6 } };
    if (method === 'showModal') return { method: 'POST', fullRoute: callback, body: { type: 9, data: options.toJSON() } };
    const { body, files } = await resolveWireBody(options);
    if (method === 'reply') return { method: 'POST', fullRoute: callback, body: { type: 4, data: body }, files };
    if (method === 'update') return { method: 'POST', fullRoute: callback, body: { type: 7, data: body }, files };
    if (method === 'editReply') return { method: 'PATCH', fullRoute: original, body, files };
    if (method === 'followUp') return { method: 'POST', fullRoute: followUp, body, files };
    if (method === 'channel.send') return { method: 'POST', fullRoute: `/channels/${channelId}/messages`, body, files };
    throw new Error(`no request for ${method}`);
  }

  // Sends what a run answered through the guard, one request at a time, and returns what reached the transport and
  // what the guard refused (code), in order.
  async function throughGuard(run) {
    const wire = [];
    for (const entry of run.raw) {
      // A channel message of a session with live egress went through the guard when it was sent.
      if (entry.live) continue;
      let request;
      try {
        request = await requestOf(entry);
      } catch (error) {
        wire.push({ source: entry.method, unbuildable: String(error?.message || error) });
        continue;
      }
      const start = wireLog.length;
      try {
        await guardedRest.request(request);
        for (const sent of wireLog.slice(start)) wire.push({ source: entry.method, ...sent });
      } catch (error) {
        wire.push({ source: entry.method, method: request.method, route: request.fullRoute, refused: error?.code || 'ERROR' });
      }
    }
    return wire;
  }

  // -------------------------------------------------------------------------------------------------------
  // runs
  // -------------------------------------------------------------------------------------------------------

  const METHODS_BY_KIND = Object.freeze({
    command: ['reply', 'deferReply', 'editReply', 'followUp', 'showModal'],
    button: ['reply', 'deferReply', 'editReply', 'followUp', 'showModal', 'update', 'deferUpdate'],
    select: ['reply', 'deferReply', 'editReply', 'followUp', 'showModal', 'update', 'deferUpdate'],
    modal: ['reply', 'deferReply', 'editReply', 'followUp', 'update', 'deferUpdate'],
  });

  // Writes down, on the run, what a command gave to each answer method, as it gave it (allowedMentions and ephemeral
  // included; the fake keeps only the text and components).
  function instrument(interaction, run, kind) {
    for (const name of METHODS_BY_KIND[kind]) {
      const original = interaction[name];
      interaction[name] = function recorded(...args) {
        // Private when the call says so, or when it edits an answer that was given privately.
        const isPrivate = args[0]?.ephemeral === true || (name === 'editReply' && interaction.ephemeral === true);
        run.raw.push({ method: name, options: args[0], interaction, public: !isPrivate });
        return original.apply(this, args);
      };
    }
    return interaction;
  }

  // A channel's send() is written down on the run that is going on, with the options the caller gave it.
  function instrumentChannel(channel) {
    if (wrappedChannels.has(channel)) return channel;
    wrappedChannels.add(channel);
    const original = channel.send;
    if (liveEgress) {
      // The message is sent through the guard and the limiter first, and is made only if they let it through, as a
      // refused request of the real client throws.
      channel.send = async function live(payload) {
        sweep.tracker.run?.raw?.push({ method: 'channel.send', options: payload, channelId: channel.id, public: true, live: true });
        await guardedRest.request(await requestOf({ method: 'channel.send', options: payload, channelId: channel.id }));
        return original.call(channel, payload);
      };
      return channel;
    }
    channel.send = function recorded(payload) {
      sweep.tracker.run?.raw?.push({ method: 'channel.send', options: payload, channelId: channel.id, public: true });
      return original.call(channel, payload);
    };
    return channel;
  }

  const session = {
    IDS,
    EXTRA_IDS,
    OWNER_DENIED,
    ADMIN_DENIED,
    environment,
    raw,
    textOfBody,
    START_TIME,
    // A fake object that throws for anything it was not given (the sweep's own).
    strict: sweep.strict,

    get world() { return world; },
    get commands() { return commands; },
    get tracker() { return tracker; },
    get limiter() { return limiter; },
    get wireLog() { return wireLog; },
    // The REST (guarded, synthetic) the runtimes of a session with live egress send through.
    get rest() { return guardedRest; },
    get publicEffectAuthority() { return publicEffectAuthority; },
    get publicSideEffects() { return publicSideEffects; },

    // One request through the guard and the limiter, the way a message of the bot's own goes out: `options` are what
    // a caller gave to reply(), send() and the like. Resolves with the transport's record, rejects as the real client
    // does (an egress refusal or a rate limit).
    async deliver({ method = 'POST', route, options }) {
      const { body, files } = await resolveWireBody(options);
      const start = wireLog.length;
      await guardedRest.request({ method, fullRoute: route, body, files });
      return wireLog.slice(start);
    },

    // The same for a request that has no message body (a reaction, a lookup).
    async request(request) {
      const start = wireLog.length;
      await guardedRest.request(request);
      return wireLog.slice(start);
    },

    users: null,
    places: null,

    async open() {
      mock.timers.enable({ apis: ['Date'], now: START_TIME });
      const { loadCommands } = require('../../src/loadCommands');
      const { createExtensionHost } = require('../../src/extensions/extensionHost');
      interactionCreate = require('../../src/events/interactionCreate');
      const extensionHost = (typeof givenHost === 'function' ? givenHost() : givenHost) || createExtensionHost();
      commands = loadCommands(undefined, { extensionHost });
      for (const entry of sweep.flattenCommandPaths(commands)) paths.set(entry.key, entry);
      await sweep.openSweepDatabase(environment);
      world = sweep.createSweepWorld({ commands, extensionHost });
      // The test-control hook the chain-reaction delivery asks the client for; a normal start has none.
      world.client.testControlRuntimeController = null;

      // The second administrator of home, who is not the bot owner.
      const home = world.guilds.approved;
      const admin = sweep.createUser(EXTRA_IDS.admin, { username: 'attack_admin', globalName: '攻擊管理員' });
      const everyone = home.roles.cache.get(home.id);
      home.members.cache.set(admin.id, sweep.createMember(home, admin, {
        permissions: [PermissionFlagsBits.Administrator], roles: [everyone],
      }));
      this.users = Object.freeze({
        owner: world.users.owner, member: world.users.member, target: world.users.target, admin,
        awayAdmin: world.users.pendingOwner, bot: world.users.bot,
      });
      this.places = Object.freeze({
        home: Object.freeze({ guild: home, channel: instrumentChannel(world.channels.approved) }),
        away: Object.freeze({ guild: world.guilds.pending, channel: instrumentChannel(world.channels.pending) }),
        dm: Object.freeze({ guild: null, channel: instrumentChannel(world.channels.direct) }),
      });

      // The limiter every outbound request is counted by (src/index.js: client.egressLimiter); the reminder timer
      // reserves from it before it sends.
      const { createEgressLimiter } = require('../../src/platform/egressLimiter');
      limiter = createEgressLimiter({ now: () => Date.now() });
      world.client.egressLimiter = limiter;
      guardedRest = installGuardedRest();
      configureRuntimes(world.client);
      tracker = sweep.createStateTracker({ roots: [environment.root], ignoredFiles: [environment.files.coinDatabase] });
      await tracker.watchNewTables();
      return this;
    },

    async close() {
      try {
        mock.timers.reset();
        if (publicSideEffects) await publicSideEffects.stop();
        require('../../src/systems/safety/chainReactionFence').configureChainReactionFence(null);
        require('../../src/platform/publicEffectAdapter').configurePublicEffectAdapter({});
        await require('../../src/games/boardRuntimeRegistry').resetBoardRuntimeForTests();
        sweep.closeSweepDatabase();
      } finally {
        restoreRejections();
        restoreLogger();
        restoreFetch();
        restoreRandomness();
        sweep.removeSweepEnvironment(environment);
      }
    },

    // A text channel of home by name (made the first time it is asked for).
    channel(name) {
      return instrumentChannel(world.channelFor(name));
    },

    // A new text channel in `where` ('home' or 'away'), and a new member of that guild; both are known to the client.
    addChannel(where, name) {
      const place = this.places[where];
      assert.ok(place?.guild, `${where} is a guild`);
      extraChannelCount += 1;
      const id = String(762100000000000000n + BigInt(extraChannelCount));
      const channel = sweep.createTextChannel(place.guild, id, name, world);
      place.guild.channels.cache.set(id, channel);
      world.client.channels.cache.set(id, channel);
      return instrumentChannel(channel);
    },

    addMember(where, id, { username } = {}) {
      const place = this.places[where];
      assert.ok(place?.guild, `${where} is a guild`);
      const user = sweep.createUser(id, { username: username || `member_${id.slice(-6)}` });
      const everyone = place.guild.roles.cache.get(place.guild.id);
      place.guild.members.cache.set(id, sweep.createMember(place.guild, user, {
        permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages], roles: [everyone],
      }));
      world.client.users.cache.set(id, user);
      return user;
    },

    // A user option naming one of the session's users: the value, and the user and member Discord resolves it to.
    person(key, where = 'home') {
      const user = this.users[key];
      assert.ok(user, `${key} is a user`);
      const guild = this.places[where].guild;
      return raw({ value: user.id, user, member: guild ? guild.members.cache.get(user.id) ?? null : null });
    },

    pathEntry(key) {
      const entry = paths.get(key);
      assert.ok(entry, `/${key} is a command path`);
      return entry;
    },

    // Moves the clock to a time (milliseconds since the epoch). The next run puts it back on its own schedule: one
    // second after the run before it, plus clockOffset.
    setTime(epochMilliseconds) {
      mock.timers.setTime(epochMilliseconds);
    },

    // Added to the time of every run from here on (a test that needs "an hour later" sets it and puts it back).
    clockOffset: 0,

    nextTime() {
      runCount += 1;
      mock.timers.setTime(START_TIME + this.clockOffset + runCount * 1000);
    },

    async mark() {
      return tracker.mark();
    },

    // Finishes a run: lets what the command left running settle, closes the run, reads what it changed and what
    // reached the egress guard, and judges it the way the sweep judges any run.
    async finish(run, interaction, mark, { sourceMessageChanged = false, networkAllowed = false } = {}) {
      await sweep.settle();
      sweep.finishRun(run);
      const changes = await tracker.changesSince(mark);
      const result = sweep.classifyRun(run, { expectAuditPending: false, networkAllowed, changes, sourceMessageChanged });
      const texts = run.events.filter((event) => ANSWER_METHODS.includes(event.method))
        .map((event) => textOfBody(event.body));
      const wire = await throughGuard(run);
      // What the commands themselves gave to each public answer, before the egress guard: the text, and whether the
      // answer carried a mention rule of its own.
      const publicAnswers = (run.raw || []).filter((entry) => entry.public && entry.options && typeof entry.options === 'object' &&
        ['content', 'embeds'].some((key) => Object.hasOwn(entry.options, key)))
        .map((entry) => ({ method: entry.method, allowedMentions: entry.options.allowedMentions, options: entry.options }));
      return {
        run, result, changes, texts, last: texts.at(-1) ?? '', wire, publicAnswers,
        methods: run.events.map((event) => event.method),
        effects: run.effects, modals: run.modals, sourceMessageChanged, interaction,
        logs: run.logs, thrown: run.thrown,
      };
    },

    // A slash command, sent by `as` in `where` ('home', 'away' or 'dm').
    //   options   by option name: a value, undefined (left out), or raw({ ... }). Required options the test does not
    //             name are filled with the sweep's generic values; optional ones that are not named are left out.
    async run(commandPath, { as = 'member', where = 'home', channel = null, options = {}, label = null } = {}) {
      const entry = this.pathEntry(commandPath);
      const place = this.places[where];
      assert.ok(place, `${where} is a place`);
      const user = this.users[as];
      assert.ok(user, `${as} is a user`);
      const target = channel ?? place.channel;
      const context = {
        world, guild: place.guild, path: entry.key, items: {}, itemIdFor: () => '0'.repeat(38), optionChannel: null,
      };
      const generated = sweep.buildOptionValues(entry, context, { variant: 'full' });
      const required = new Set(entry.options.filter((option) => option.required).map((option) => option.name));
      const values = [];
      for (const value of generated) {
        const given = Object.hasOwn(options, value.name);
        if (given && options[value.name] === undefined) continue;
        if (!given && !required.has(value.name)) continue;
        if (!given) values.push(value);
        else if (isRaw(options[value.name])) {
          const { [RAW]: ignored, ...fields } = options[value.name];
          values.push({ name: value.name, type: value.type, ...fields });
        } else values.push({ ...value, value: options[value.name] });
      }
      // An option the test names that the generator left out (a user in a direct message, for one) is added as given.
      this.nextTime();
      const mark = await tracker.mark();
      const run = sweep.beginRun({
        path: entry.key, actor: as, variant: label || `${as} in ${where}`, options: sweep.describeOptionValues(values),
      });
      run.raw = [];
      const interaction = instrument(sweep.createChatInputInteraction(world, {
        run, user, guild: place.guild, channel: target, entry, values,
      }), run, 'command');
      try {
        await interactionCreate.execute(interaction);
      } catch (error) {
        run.thrown = error;
      }
      return this.finish(run, interaction, mark);
    },

    // Work that is not an interaction (a timer that fires, a delivery) run as a run of its own, so what it sends and
    // writes is read the same way: `work(run)` is awaited, and the outcome has the same shape as an interaction's.
    async act(label, work, { as = 'system' } = {}) {
      this.nextTime();
      const mark = await tracker.mark();
      const run = sweep.beginRun({ path: label, actor: as, variant: label, options: {} });
      run.raw = [];
      try {
        await work(run);
      } catch (error) {
        run.thrown = error;
      }
      return this.finish(run, null, mark);
    },

    // The controls a message shows now, by custom ID.
    controlsOf(message) {
      return sweep.componentsOf(world, message);
    },

    // A message the bot made in `channel` (a stand-in for another panel, or for a message of another place).
    makeMessage(channel, content = '合成訊息') {
      return world.createMessage(channel, { content }, { author: world.botUser });
    },

    // The message with controls a run left on screen (the latest one), with its channel.
    panelOf(outcome, { path: commandPath, variant } = {}) {
      const wantPath = commandPath ?? outcome.run.path;
      const wantVariant = variant ?? outcome.run.variant;
      const found = world.messages.filter((entry) => entry.origin?.path === wantPath && entry.origin.variant === wantVariant &&
        sweep.componentsOf(world, entry.message).length > 0);
      return found.at(-1) ?? null;
    },

    // A control pressed: `customId` as sent by `as` in `where`, on `message` (the message the control is on, as the
    // interaction carries it; a stand-in for another message makes a replay). `component` replaces the plain button.
    async press(customId, {
      as = 'member', where = 'home', channel = null, message, component = null, values = [], label = null,
    } = {}) {
      const place = this.places[where];
      const user = this.users[as];
      assert.ok(place && user, 'a place and a user');
      assert.ok(message, 'a message the control is on');
      const target = channel ?? place.channel;
      const control = component ?? { type: ComponentType.Button, custom_id: customId, style: 1, label: '控制項' };
      this.nextTime();
      const before = JSON.stringify(world.stateOf(message));
      const mark = await tracker.mark();
      const run = sweep.beginRun({
        path: `press ${customId.split('|').slice(0, 2).join('|')}`, actor: as, variant: label || `${as} in ${where}`,
        options: { customId },
      });
      run.raw = [];
      const kind = control.type === ComponentType.StringSelect ? 'select' : 'button';
      const interaction = instrument(sweep.createComponentInteraction(world, {
        run, user, guild: place.guild, channel: target, message, component: control, values,
      }), run, kind);
      try {
        await interactionCreate.execute(interaction);
      } catch (error) {
        run.thrown = error;
      }
      const sourceMessageChanged = JSON.stringify(world.stateOf(message)) !== before;
      return this.finish(run, interaction, mark, { sourceMessageChanged });
    },

    // A modal submitted: `modal` is { customId, title, inputs } as a run left it (outcome.modals[0]).
    async submit(modal, {
      as = 'member', where = 'home', channel = null, message, fields = {}, label = null,
    } = {}) {
      const place = this.places[where];
      const user = this.users[as];
      assert.ok(place && user, 'a place and a user');
      assert.ok(message, 'a message the modal was shown from');
      const target = channel ?? place.channel;
      this.nextTime();
      const before = JSON.stringify(world.stateOf(message));
      const mark = await tracker.mark();
      const run = sweep.beginRun({
        path: `submit ${modal.customId.split('|').slice(0, 2).join('|')}`, actor: as, variant: label || `${as} in ${where}`,
        options: { customId: modal.customId, ...fields },
      });
      run.raw = [];
      const interaction = instrument(sweep.createModalSubmitInteraction(world, {
        run, user, guild: place.guild, channel: target, message, modal, fieldValues: fields,
      }), run, 'modal');
      try {
        await interactionCreate.execute(interaction);
      } catch (error) {
        run.thrown = error;
      }
      const sourceMessageChanged = JSON.stringify(world.stateOf(message)) !== before;
      return this.finish(run, interaction, mark, { sourceMessageChanged });
    },

    // What a run changed in what the bot keeps, beyond the count of interactions interactionCreate keeps for every
    // answered one: tables, files, the schema and everything that reached the fake Discord.
    changesBeyondTheCount(outcome) {
      return sweep.changesBeyond(outcome.result, Object.fromEntries(COUNTED_INTERACTION_TABLES.map((table) => [table, true])));
    },
  };

  return session;
}

// ---------------------------------------------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------------------------------------------

// The run did not fail on its own: no rejection out of the handler, no promise left unhandled, nothing the fake could
// not answer, no message Discord would refuse, and the handler's own failure answer was not given.
function assertRanCleanly(outcome, label = 'the run') {
  assert.equal(outcome.thrown, null, `${label}: the handler rejected: ${outcome.thrown?.stack}`);
  assert.deepEqual(outcome.run.unhandled.map(String), [], `${label}: a promise was rejected unhandled`);
  assert.deepEqual([...new Set(outcome.run.missing)], [], `${label}: the fake Discord had no answer for this`);
  assert.deepEqual(outcome.run.violations, [], `${label}: a message Discord would refuse, or text that must not be shown`);
  assert.deepEqual(outcome.run.protocol, [], `${label}: the interaction was answered against the protocol`);
  assert.ok(!outcome.texts.some((text) => text.includes(sweep.COMMAND_FAILED_MESSAGE)),
    `${label}: the handler's failure answer was given: ${JSON.stringify(outcome.texts)}`);
}

// A refused run changed nothing: no table beyond the interaction count, no file, no schema, no message, reaction,
// thread or REST request, and not the message its control was on.
function assertChangedNothing(session, outcome, label = 'the run') {
  assert.deepEqual(session.changesBeyondTheCount(outcome), [], `${label}: a refused run changed something`);
  assert.deepEqual(outcome.wire.filter((sent) => sent.route && !/\/callback$|\/webhooks\//u.test(sent.route)), [],
    `${label}: a refused run sent a channel message`);
}

// Answered once, privately, with `expected` (a string or a pattern).
function assertRefusedWith(outcome, expected, label = 'the run') {
  assert.equal(outcome.texts.length, 1, `${label}: one answer: ${JSON.stringify(outcome.texts)}`);
  if (expected instanceof RegExp) assert.match(outcome.last, expected, label);
  else assert.equal(outcome.last, expected, label);
  const first = outcome.run.events.find((event) => ANSWER_METHODS.includes(event.method));
  assert.equal(first?.body?.ephemeral, true, `${label}: a refusal is private`);
}

// What the wire of a run would notify, from what reached the transport after the egress guard: the user and role IDs a
// message would ping and whether it would ping everyone. `allowed_mentions` decides, not the text.
function notifiedBy(body) {
  const text = [body?.content, ...(body?.embeds || []).flatMap((embed) => [embed?.title, embed?.description,
    ...(embed?.fields || []).flatMap((field) => [field?.name, field?.value])])].filter((part) => typeof part === 'string').join('\n');
  const allowed = body?.allowed_mentions;
  // A body without allowed_mentions would notify every mention in it; the guard always sets one.
  const parse = allowed ? (allowed.parse || []) : ['users', 'roles', 'everyone'];
  const users = new Set(allowed?.users || []);
  const roles = new Set(allowed?.roles || []);
  const mentionedUsers = [...text.matchAll(/<@!?(\d{15,25})>/gu)].map((match) => match[1]);
  const mentionedRoles = [...text.matchAll(/<@&(\d{15,25})>/gu)].map((match) => match[1]);
  return {
    users: [...new Set(mentionedUsers.filter((id) => parse.includes('users') || users.has(id)))],
    roles: [...new Set(mentionedRoles.filter((id) => parse.includes('roles') || roles.has(id)))],
    everyone: parse.includes('everyone') && /@(?:everyone|here)\b/u.test(text),
    text,
  };
}

module.exports = {
  ADMIN_DENIED,
  APPROVED_RELEASE_TAG,
  COUNTED_INTERACTION_TABLES,
  EXTRA_IDS,
  OWNER_DENIED,
  START_TIME,
  assertChangedNothing,
  assertRanCleanly,
  assertRefusedWith,
  createAttackSession,
  notifiedBy,
  raw,
  textOfBody,
};
