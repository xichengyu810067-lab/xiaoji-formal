'use strict';

// Guilds are no longer reviewed. This sweep runs the entries that used to ask "is this guild approved?" with every state
// an earlier version could have left for a guild on disk (a record that says unknown, denied or pending, and no record at
// all), and checks for each that it serves as in any other guild and leaves the audit file as it was, byte for byte (or
// not created). guildReviewRemoval.test.js looks for the old names in the sources; a gate brought back under another name
// stops one of these entries from serving, and fails here.
//
// Entries: the real messageCreate (a mention and a message that is not one), guildMemberAdd (the welcome), the work
// penalty announcement, the word chain reaction outbox, the /board command (a board game and a personal game), the real
// board runtime (its start, buttons and input window), and the /daily-riddle, /daily-discussion and /release-announcements
// settings. The last test is another server's administrator, who is not the Owner, against /economy and /coin-admin. Only
// Discord is faked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ApplicationCommandOptionType,
  ChannelType,
  CommandInteractionOptionResolver,
  PermissionFlagsBits,
} = require('discord.js');

const { makeRealTempDir, removeRealTempDir } = require('./support/realTempDir');

const root = makeRealTempDir('xiaoji-guild-review-sweep-');
const AUDIT_PATH = path.join(root, 'guildAudit.json');
const WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');
const OWNER_ID = '10000000000000900';
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.XIAOJI_AUDIT_DATA_PATH = AUDIT_PATH;
process.env.XIAOJI_INVITER_WHITELIST_PATH = WHITELIST_PATH;
process.env.BOT_OWNER_ID = OWNER_ID;
process.env.AI_CONVERSATION_PATH = path.join(root, 'history.json');
process.env.XIAOJI_MEMORY_PATH = path.join(root, 'memory.json');

const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const memoryService = require('../src/services/memoryService');
const { createPublicEffectAuthority } = require('../src/platform/publicEffectGrant');
const { configurePublicEffectAdapter } = require('../src/platform/publicEffectAdapter');
const { captureDiscordEventContext, runWithHostOperationContext } = require('../src/platform/hostOperationContext');
const { createWelcomedMembers, setWelcomedMembersForTests } = require('../src/systems/community/welcomedMembers');
const { AI_SPAM_PRESENCE_REPLY } = require('../src/systems/conversation/aiSpamGuard');
const { clearConversationStateForTests } = require('../src/services/conversationModeService');
const logger = require('../src/utils/logger');

const BOT_ID = '10000000000000001';
const GUILD_ID = '10000000000000002';
const CHANNEL_ID = '10000000000000003';
const USER_ID = '10000000000000004';
const OTHER_GUILD_ID = '10000000000000005';

// The four states of a guild. `record` is what the audit file holds for the guild; null leaves it out.
const STATES = Object.freeze([
  ['unknown', { guildId: GUILD_ID, status: 'unknown', manualAudit: true }],
  ['denied', { guildId: GUILD_ID, status: 'denied', reason: 'Audit timeout (24h)' }],
  ['pending', { guildId: GUILD_ID, status: 'pending' }],
  ['no record', null],
]);

// Writes the audit file the way the state says and returns what it holds, to compare with afterwards: the text, or
// null for a file that must still not exist.
function enterState(record) {
  fs.rmSync(AUDIT_PATH, { force: true });
  fs.rmSync(WHITELIST_PATH, { force: true });
  fs.writeFileSync(WHITELIST_PATH, '[]\n');
  if (!record) return null;
  const text = `${JSON.stringify({ [GUILD_ID]: record }, null, 2)}\n`;
  fs.writeFileSync(AUDIT_PATH, text);
  return text;
}

function assertAuditUntouched(before, label) {
  if (before === null) assert.equal(fs.existsSync(AUDIT_PATH), false, `${label}: no audit file is created`);
  else assert.equal(fs.readFileSync(AUDIT_PATH, 'utf8'), before, `${label}: the audit file is as it was`);
  assert.equal(fs.readFileSync(WHITELIST_PATH, 'utf8'), '[]\n', `${label}: the whitelist is as it was`);
}

async function freshDatabase() {
  resetCoinDatabaseForTests();
  fs.rmSync(process.env.COIN_DB_PATH, { force: true });
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
}

async function quietly(callback) {
  const original = { info: logger.info, warn: logger.warn, error: logger.error };
  logger.info = () => {};
  logger.warn = () => {};
  logger.error = () => {};
  try {
    return await callback();
  } finally {
    Object.assign(logger, original);
  }
}

test.after(() => {
  setWelcomedMembersForTests(null);
  clearConversationStateForTests();
  resetCoinDatabaseForTests();
  removeRealTempDir(root);
});

// ---- messageCreate --------------------------------------------------------------------------------------------

function snowflake(index, prefix = '7') {
  return `${prefix}${String(index).padStart(16, '0')}`;
}

test('the real messageCreate answers a mention and takes in a message that is not one, whatever the guild was recorded as', async () => {
  // The record of public messages is observed at the point the event hands a message to it.
  const recorded = [];
  const original = memoryService.recordPublicMessage;
  memoryService.recordPublicMessage = (message) => { recorded.push(message.content); return null; };
  const eventPath = require.resolve('../src/events/messageCreate');
  delete require.cache[eventPath];
  const messageCreate = require(eventPath);
  try {
    await freshDatabase();
    let number = 0;
    for (const [label, record] of STATES) {
      number += 1;
      const before = enterState(record);
      const replies = [];
      const message = (content, userId) => ({
        id: snowflake(number * 10 + replies.length),
        content,
        author: { id: userId, username: `member-${userId.slice(-3)}`, bot: false },
        member: { displayName: `member-${userId.slice(-3)}` },
        client: { user: { id: BOT_ID } },
        guildId: GUILD_ID,
        // A channel of its own for each state: the fixed line is limited per channel as well as per member.
        channelId: snowflake(number, '3'),
        createdTimestamp: Date.now(),
        stickers: { size: 0 },
        attachments: { size: 0 },
        mentions: { has: () => false },
        async reply(payload) { replies.push(payload); },
        channel: { async send(payload) { replies.push(payload); }, messages: { async fetch() { return null; } } },
      });

      // A mention with nothing else: the fixed line, sent to the member.
      await quietly(() => messageCreate.execute(message(`<@${BOT_ID}>`, snowflake(number, '4'))));
      assert.deepEqual(replies.map((payload) => payload.content), [AI_SPAM_PRESENCE_REPLY], label);

      // A message that mentions no one is taken in as an ordinary public message.
      const ordinary = `今天天氣真好 ${label}`;
      await quietly(() => messageCreate.execute(message(ordinary, snowflake(number, '5'))));
      assert.equal(recorded.includes(ordinary), true, label);
      assert.equal(replies.length, 1, `${label}: an ordinary message gets no answer`);
      assertAuditUntouched(before, label);
    }
  } finally {
    memoryService.recordPublicMessage = original;
    delete require.cache[eventPath];
  }
});

// ---- guildMemberAdd -------------------------------------------------------------------------------------------

function textChannel(id) {
  return {
    id,
    type: ChannelType.GuildText,
    rawPosition: 0,
    isTextBased: () => true,
    permissionsFor: () => ({ has: (permission) => [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages].includes(permission) }),
  };
}

function joiningMember(memberId, welcomeRuntime) {
  const botMember = { id: BOT_ID, partial: false };
  const channel = textChannel(CHANNEL_ID);
  return {
    id: memberId,
    joinedTimestamp: Date.now(),
    user: { id: memberId, bot: false },
    client: { user: { id: BOT_ID }, welcomeSideEffectRuntime: welcomeRuntime },
    toString: () => `<@${memberId}>`,
    guild: {
      id: GUILD_ID,
      members: { me: botMember, fetchMe: async () => botMember },
      channels: { cache: new Map([[CHANNEL_ID, channel]]), fetch: async () => new Map([[CHANNEL_ID, channel]]) },
      systemChannel: null,
    },
  };
}

test('the real guildMemberAdd welcomes a new member once, whatever the guild was recorded as', async () => {
  const guildMemberAdd = require('../src/events/guildMemberAdd');
  let number = 0;
  for (const [label, record] of STATES) {
    number += 1;
    const before = enterState(record);
    setWelcomedMembersForTests(createWelcomedMembers({
      filePath: path.join(root, `welcomed-${number}.json`),
      logger: { warn() {}, info() {}, error() {} },
    }));
    const accepted = [];
    const welcomeRuntime = {
      issueGrant: () => Object.freeze({ authorized: true }),
      accept: (grant, effect) => { accepted.push(effect); return true; },
    };
    const authority = createPublicEffectAuthority();
    const memberId = snowflake(number, '6');
    const member = joiningMember(memberId, welcomeRuntime);
    const context = captureDiscordEventContext('guildMemberAdd', [member], { publicEffectAuthority: authority });
    await quietly(() => runWithHostOperationContext(context, () => guildMemberAdd.execute(member)));
    assert.equal(accepted.length, 1, `${label}: the welcome is accepted for sending`);
    assert.equal(accepted[0].route, `/channels/${CHANNEL_ID}/messages`, label);
    assert.deepEqual(accepted[0].body.allowed_mentions, { parse: [], users: [memberId], roles: [], replied_user: false }, label);

    // The same member joining again is not welcomed again: that is the record of who was welcomed, not the guild's state.
    const again = joiningMember(memberId, welcomeRuntime);
    const againContext = captureDiscordEventContext('guildMemberAdd', [again], { publicEffectAuthority: authority });
    await quietly(() => runWithHostOperationContext(againContext, () => guildMemberAdd.execute(again)));
    assert.equal(accepted.length, 1, `${label}: welcomed once`);
    assertAuditUntouched(before, label);
  }
});

// ---- work penalty announcements and the word chain reaction ---------------------------------------------------

const CUTOVER = 1_700_000_000_000;
const DISCORD_EPOCH = 1_420_070_400_000n;

function messageSnowflake(timestamp, increment = 1n) {
  return (((BigInt(timestamp) - DISCORD_EPOCH) << 22n) + increment).toString();
}

// The public side-effect runtime on ledgers made for the test, armed as at ready, with a REST that records what it is
// asked to do.
function createRuntime(name) {
  const { PublicSideEffectRuntime } = require('../src/systems/safety/publicSideEffectRuntime');
  const { initializePublicLedgers, openPublicLedgers } = require('./fixtures/publicLedgers');
  const { createSyntheticRest } = require('./fixtures/syntheticRest');
  const { configureChainReactionFence } = require('../src/systems/safety/chainReactionFence');
  const calls = [];
  const handlers = {
    calls,
    options: { retries: 0 },
    put: async (route) => { calls.push(['PUT', route]); return {}; },
    post: async (route) => {
      calls.push(['POST', route]);
      return { id: messageSnowflake(CUTOVER + 5_000, BigInt(calls.length)), channel_id: route.split('/')[2] };
    },
  };
  const authority = createPublicEffectAuthority();
  const ledgers = initializePublicLedgers({ root, name, botId: BOT_ID, cutover: CUTOVER });
  const now = () => CUTOVER + 10_000;
  const runtime = new PublicSideEffectRuntime({
    client: { rest: createSyntheticRest(handlers) }, botId: BOT_ID, env: {}, now, effectAuthority: authority,
  });
  assert.deepEqual(runtime.preflight({ ledgers: openPublicLedgers(ledgers, { botId: BOT_ID, now }) }).disabled, []);
  runtime.arm();
  configurePublicEffectAdapter({ publicEffectRuntime: runtime, publicEffectIssuer: authority.createIssuer() });
  configureChainReactionFence(runtime);
  return { runtime, calls, handlers };
}

test('the work penalty announcement is sent, whatever the guild was recorded as', async () => {
  const { processWorkPenaltyAnnouncements } = require('../src/systems/work/workService');
  let number = 0;
  for (const [label, record] of STATES) {
    number += 1;
    const before = enterState(record);
    await freshDatabase();
    const state = createRuntime(`penalty-${number}`);
    try {
      const createdAt = new Date(CUTOVER + 1_000).toISOString();
      await withCoinTransaction((api) => api.run(
        `INSERT INTO coin_work_penalties
          (guild_id, user_id, job_id, job_name, source_type, source_channel_id, penalty_date,
           daily_salary, penalty_amount, status, reason, appeal_deadline_at, created_at, updated_at)
         VALUES (?, ?, 1, '測試職業', 'synthetic', ?, '2023-11-14', 1000, 250, 'active', '合成測試', ?, ?, ?)`,
        [GUILD_ID, USER_ID, CHANNEL_ID, new Date(CUTOVER + 86_400_000).toISOString(), createdAt, createdAt]
      ));
      const channel = { id: CHANNEL_ID, isTextBased: () => true, isSendable: () => true };
      const guild = { channels: { fetch: async (id) => (id === CHANNEL_ID ? channel : null), cache: { find: () => channel } } };
      const client = {
        user: { id: BOT_ID },
        rest: state.handlers,
        guilds: { fetch: async (id) => (id === GUILD_ID ? guild : null) },
        testControlRuntimeController: { isStopping: () => false },
      };
      const summary = await quietly(() => processWorkPenaltyAnnouncements(client, { guildId: GUILD_ID, limit: 10 }));
      assert.equal(summary.announced, 1, `${label}: ${JSON.stringify(summary)}`);
      assert.deepEqual(state.calls, [['POST', `/channels/${CHANNEL_ID}/messages`]], label);
      assertAuditUntouched(before, label);
    } finally {
      await state.runtime.stop();
    }
  }
});

test('the word chain reaction is sent from the outbox, whatever the guild was recorded as', async () => {
  const { acceptWordChainMessage, processWordChainReactionOutbox, startWordChain } = require('../src/services/wordChainService');
  let number = 0;
  for (const [label, record] of STATES) {
    number += 1;
    const before = enterState(record);
    await freshDatabase();
    const state = createRuntime(`reaction-${number}`);
    try {
      await quietly(() => startWordChain({
        guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID, seed: '地球', now: new Date(CUTOVER + 1_000),
      }));
      const accepted = await quietly(() => acceptWordChainMessage({
        guildId: GUILD_ID, channelId: CHANNEL_ID, messageId: messageSnowflake(CUTOVER + 2_000, 9n), userId: USER_ID,
        content: '球體', now: new Date(CUTOVER + 2_000),
      }));
      assert.ok(accepted.reactionSource, `${label}: the answer is accepted with a reaction to give`);
      const summary = await quietly(() => processWordChainReactionOutbox(
        { rest: state.handlers }, { permissionCheck: () => true }));
      assert.equal(summary.delivered, 1, `${label}: ${JSON.stringify(summary)}`);
      assert.deepEqual(state.calls.map(([method]) => method), ['PUT'], label);
      assertAuditUntouched(before, label);
    } finally {
      await state.runtime.stop();
    }
  }
});

// ---- /board: a board game and a personal game -----------------------------------------------------------------

// A /board interaction built on the real discord.js option resolver; only the reply methods are recorded fakes.
function boardInteraction({ id, subcommand = 'start', values = {}, userId, guildId = GUILD_ID, channelId = CHANNEL_ID, client = {} }) {
  const data = Object.entries(values).map(([name, value]) => ({
    type: ApplicationCommandOptionType.String, name, value,
  }));
  const log = { replies: [], deferred: [], edits: [] };
  const interaction = {
    id,
    client,
    guildId,
    channelId,
    channel: { id: channelId, isTextBased: () => true, send: async () => ({ id: 'sent-message' }), permissionsFor: () => ({ has: () => true }) },
    commandName: 'board',
    user: { id: userId, toString: () => `<@${userId}>` },
    guild: { id: guildId, members: { me: {}, fetch: async () => ({ permissions: { has: () => false } }) } },
    memberPermissions: { has: () => false },
    deferred: false,
    replied: false,
    inGuild: () => true,
    options: new CommandInteractionOptionResolver(client, [{
      type: ApplicationCommandOptionType.Subcommand, name: subcommand, options: data,
    }], {}),
    async reply(payload) { this.replied = true; log.replies.push(payload); return payload; },
    async deferReply(payload) { this.deferred = true; log.deferred.push(payload ?? null); },
    async editReply(payload) { this.replied = true; log.edits.push(payload); return payload; },
    async followUp(payload) { log.replies.push(payload); return payload; },
    async fetchReply() { return { id: `${id}-message` }; },
  };
  return { interaction, log };
}

test('/board starts a board game and a personal game for a member who is not an administrator, whatever the guild was recorded as', async () => {
  const boardCommand = require('../src/commands/board');
  const { configureBoardRuntime, resetBoardRuntimeForTests } = require('../src/games/boardRuntimeRegistry');
  const { configureSoloRuntime } = require('../src/systems/games/soloRuntimeRegistry');
  const { createSoloDiscordRuntime } = require('../src/systems/games/soloDiscordRuntime');
  const { createSoloSessionService } = require('../src/systems/games/soloSessionService');
  let number = 0;
  for (const [label, record] of STATES) {
    number += 1;
    const before = enterState(record);
    await freshDatabase();

    // A board game goes to the board runtime.
    const handled = [];
    await resetBoardRuntimeForTests();
    configureBoardRuntime({
      executeCommand: async (interaction) => { handled.push(interaction.id); return { ok: true }; },
      handleInteraction: async () => null,
      startLifecycle: async () => null,
      stopLifecycle: async () => null,
      service: { status: async () => { throw Object.assign(new Error('no board'), { code: 'SESSION_NOT_FOUND' }); } },
    });
    const chess = boardInteraction({ id: `sweep-chess-${number}`, userId: USER_ID, values: { game: 'chess' } });
    assert.deepEqual(await boardCommand.execute(chess.interaction), { ok: true }, label);
    assert.deepEqual(handled, [`sweep-chess-${number}`], label);

    // A personal game opens a session on the real database and binds its panel.
    const client = { channels: { fetch: async () => null } };
    configureSoloRuntime(createSoloDiscordRuntime({
      service: createSoloSessionService({ withDatabase: withCoinDatabase, withTransaction: withCoinTransaction }),
      client,
      renderPng: () => Buffer.alloc(16),
    }));
    const soloChannelId = snowflake(number, '8');
    const solo = boardInteraction({
      id: `sweep-solo-${number}`, userId: USER_ID, channelId: soloChannelId, client,
      values: { game: 'sudoku', difficulty: 'easy' },
    });
    await quietly(() => boardCommand.execute(solo.interaction));
    assert.equal(solo.log.edits.length, 1, `${label}: ${JSON.stringify(solo.log)}`);
    assert.match(solo.log.edits[0].content, /^數獨・簡單｜進行中/u, label);
    const session = await withCoinDatabase((api) => api.get(
      'SELECT game_type, status, message_id FROM discord_game_sessions WHERE user_id = ? AND channel_id = ?',
      [USER_ID, soloChannelId]));
    assert.deepEqual({ ...session },
      { game_type: 'sudoku', status: 'active', message_id: `sweep-solo-${number}-message` }, label);
    const receipt = await withCoinDatabase((api) => api.get(
      'SELECT kind, user_id, guild_id FROM game_launch_receipts WHERE interaction_id = ?', [`sweep-solo-${number}`]));
    assert.deepEqual({ ...receipt }, { kind: 'solo-game', user_id: USER_ID, guild_id: GUILD_ID }, label);
    assertAuditUntouched(before, label);
  }
  await resetBoardRuntimeForTests();
});

// ---- /daily-riddle, /daily-discussion and /release-announcements ---------------------------------------------------

test('the settings of /daily-riddle, /daily-discussion and /release-announcements are saved for an administrator, whatever the guild was recorded as', async () => {
  const { getGuildFeatureSetting } = require('../src/services/featurePlatformService');
  const { FEATURE_KEY: RELEASE_FEATURE_KEY } = require('../src/services/releaseAnnouncementService');
  const commands = [
    ['daily-riddle', 'enable', 'daily_riddle', '每日猜謎已啟用'],
    ['daily-discussion', 'enable', 'daily_discussion', '每日議題已啟用'],
    ['release-announcements', 'set', RELEASE_FEATURE_KEY, '公告發布頻道設為'],
  ];
  const channelPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks];
  let number = 0;
  for (const [label, record] of STATES) {
    number += 1;
    const before = enterState(record);
    await freshDatabase();
    for (const [commandName, subcommand, featureKey, confirmation] of commands) {
      const command = require(`../src/commands/${commandName}`);
      const channelId = snowflake(number, '9');
      const channel = {
        id: channelId,
        guildId: GUILD_ID,
        name: 'sweep-channel',
        type: ChannelType.GuildText,
        isThread: () => false,
        permissionsFor: () => ({ has: (permission) => channelPermissions.includes(permission) }),
      };
      const replies = [];
      const botMember = { id: BOT_ID, partial: false, permissions: { has: () => true } };
      const interaction = {
        commandName,
        guildId: GUILD_ID,
        guild: { id: GUILD_ID, members: { me: botMember, fetchMe: async () => botMember, fetch: async () => null } },
        user: { id: USER_ID },
        memberPermissions: { has: (permission) => permission === PermissionFlagsBits.Administrator },
        replied: false,
        deferred: false,
        inGuild: () => true,
        options: { getSubcommand: () => subcommand, getChannel: () => channel },
        async reply(payload) { this.replied = true; replies.push(payload); },
        async followUp(payload) { replies.push(payload); },
      };
      await quietly(() => command.execute(interaction));
      assert.equal(replies.length, 1, `${label} ${commandName}`);
      assert.match(replies[0].content, new RegExp(confirmation, 'u'), `${label} ${commandName}: ${replies[0].content}`);
      const setting = await getGuildFeatureSetting(GUILD_ID, featureKey);
      assert.deepEqual([setting.enabled, setting.channelId], [true, channelId], `${label} ${commandName}`);
    }
    assertAuditUntouched(before, label);
  }
});

// ---- an administrator of another server -----------------------------------------------------------------------

const HOME_NAME = 'Home Server';
const AWAY_NAME = 'Away Server';

// A slash command interaction with the answers of a real option reader and a guild that knows its own members. The
// guild gives `memberPermissions` the way Discord does: the permissions of the member in the guild the command is used in.
function adminInteraction({ commandName, subcommand, guildId, userId, administrator, members, users = {}, strings = {}, integers = {} }) {
  const replies = [];
  const botMember = { id: BOT_ID, partial: false, permissions: { has: () => true } };
  const known = new Map(members.map((id) => [id, { id, user: { id }, permissions: { has: () => administrator && id === userId } }]));
  const interaction = {
    commandName,
    id: `sweep-${commandName}-${subcommand}`,
    guildId,
    guild: {
      id: guildId,
      name: guildId === GUILD_ID ? HOME_NAME : AWAY_NAME,
      members: {
        me: botMember,
        fetchMe: async () => botMember,
        cache: new Map(),
        fetch: async (id) => {
          if (id === undefined) return known;
          const member = known.get(String(id));
          if (!member) throw new Error('Unknown Member');
          return member;
        },
      },
    },
    user: { id: userId, tag: 'admin#0', username: 'admin' },
    client: {},
    memberPermissions: { has: () => administrator },
    replied: false,
    deferred: false,
    inGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getUser: (name) => users[name] ?? null,
      getString: (name) => strings[name] ?? null,
      getInteger: (name) => integers[name] ?? null,
      getRole: () => null,
      getMember: () => null,
      getChannel: () => null,
      getBoolean: () => null,
    },
    async reply(payload) { this.replied = true; replies.push(payload); },
    async followUp(payload) { replies.push(payload); },
  };
  return { interaction, replies };
}

test('an administrator of another server, who is not the Owner, reads and changes nothing of this server through /economy and /coin-admin', async () => {
  const economy = require('../src/commands/economy');
  const coinAdmin = require('../src/commands/coin-admin');
  const { OWNER_DENIED_MESSAGE } = require('../src/utils/ownerOnly');
  const { adjustPlayerBalance, setGuildEconomyEnabled } = require('../src/services/coinService');
  const HOME_MEMBER = snowflake(1, '2');
  const AWAY_ADMIN = snowflake(2, '2');
  const NOT_A_MEMBER = '只能查詢目前在此伺服器的成員。';

  await freshDatabase();
  enterState(STATES[1][1]);
  await adjustPlayerBalance(GUILD_ID, HOME_MEMBER, {
    action: 'add', amount: 500, operatorId: OWNER_ID, reason: 'synthetic fixture',
  });
  await setGuildEconomyEnabled(GUILD_ID, true, { operatorId: OWNER_ID });

  // What this server holds: its settings, its admin log, its transactions, and the wallet of its member.
  const homeState = () => withCoinDatabase((api) => JSON.stringify({
    settings: api.all('SELECT * FROM coin_guild_settings WHERE guild_id = ?', [GUILD_ID]),
    logs: api.all('SELECT * FROM coin_admin_logs WHERE guild_id = ? ORDER BY id', [GUILD_ID]),
    transactions: api.all('SELECT * FROM coin_transactions WHERE guild_id = ? ORDER BY id', [GUILD_ID]),
    wallets: api.all('SELECT * FROM coin_wallets ORDER BY user_id'),
  }));
  const home = await homeState();
  assert.ok(JSON.parse(home).settings.length === 1 && JSON.parse(home).wallets.length === 1);

  const asAdmin = (guildId, administrator, commandName, subcommand, options = {}) => adminInteraction({
    commandName, subcommand, guildId, userId: AWAY_ADMIN, administrator,
    members: guildId === GUILD_ID ? [HOME_MEMBER, AWAY_ADMIN] : [AWAY_ADMIN], ...options,
  });
  const commands = { economy, 'coin-admin': coinAdmin };
  const run = async (guildId, administrator, commandName, subcommand, options) => {
    const { interaction, replies } = asAdmin(guildId, administrator, commandName, subcommand, options);
    await quietly(() => commands[commandName].execute(interaction));
    assert.equal(replies.length, 1, `${commandName} ${subcommand}: one answer`);
    return String(replies[0].content);
  };
  const target = { users: { user: { id: HOME_MEMBER, username: 'home-member', globalName: null, toString: () => `<@${HOME_MEMBER}>` } } };
  const attempts = [
    ['economy', 'overview', {}],
    ['economy', 'user', target],
    ['economy', 'audit', { strings: { type: 'transactions' } }],
    ['coin-admin', 'enable', {}],
    ['coin-admin', 'disable', {}],
    ['coin-admin', 'history', target],
    ['coin-admin', 'remove', { ...target, integers: { amount: 100 }, strings: { reason: 'synthetic' } }],
    ['coin-admin', 'set', { ...target, integers: { amount: 0 }, strings: { reason: 'synthetic' } }],
    ['coin-admin', 'reset-user', { ...target, strings: { confirm: 'RESET' } }],
  ];

  // In this server, where the member has no Administrator permission: refused, and nothing of this server moves.
  for (const [commandName, subcommand, options] of attempts) {
    const content = await run(GUILD_ID, false, commandName, subcommand, options);
    assert.match(content, new RegExp(`Administrator 權限|${OWNER_DENIED_MESSAGE}`, 'u'), `${commandName} ${subcommand}: ${content}`);
    assert.equal(await homeState(), home, `${commandName} ${subcommand} in this server`);
  }

  // In their own server, as its administrator: what they set is their own server's, and what they read is theirs.
  assert.match(await run(OTHER_GUILD_ID, true, 'coin-admin', 'disable'), /已停用/u);
  assert.equal(await homeState(), home, 'this server keeps its settings when the other one is switched off');
  const away = await withCoinDatabase((api) => api.all('SELECT guild_id, enabled FROM coin_guild_settings ORDER BY guild_id'));
  assert.deepEqual(away.map((row) => [row.guild_id, Number(row.enabled)]), [[GUILD_ID, 1], [OTHER_GUILD_ID, 0]]);
  assert.match(await run(OTHER_GUILD_ID, true, 'coin-admin', 'enable'), /已啟用/u);

  const overview = await run(OTHER_GUILD_ID, true, 'economy', 'overview');
  assert.ok(overview.includes(AWAY_NAME) && overview.includes('玩家數：0'), overview);
  assert.equal(overview.includes(HOME_NAME) || overview.includes(HOME_MEMBER), false, overview);
  assert.equal(await run(OTHER_GUILD_ID, true, 'economy', 'user', target), NOT_A_MEMBER);
  const audit = await run(OTHER_GUILD_ID, true, 'economy', 'audit', { strings: { type: 'transactions' } });
  assert.equal(audit.includes(HOME_MEMBER) || audit.includes(HOME_NAME), false, audit);

  // The wallets are shared by every server, so changing one is for the Owner alone, wherever the command is used.
  for (const [subcommand, extra] of [['remove', { integers: { amount: 100 }, strings: { reason: 'synthetic' } }],
    ['set', { integers: { amount: 0 }, strings: { reason: 'synthetic' } }], ['reset-user', { strings: { confirm: 'RESET' } }]]) {
    assert.equal(await run(OTHER_GUILD_ID, true, 'coin-admin', subcommand, { ...target, ...extra }), OWNER_DENIED_MESSAGE, subcommand);
    assert.equal(await homeState(), home, `${subcommand} in the other server`);
  }
});

// ---- the board runtime itself: the board's buttons and its input window --------------------------------------------

let nextBoardInteraction = 0;

// A button or a submitted input window on the board message of a game, with the replies kept.
function boardComponent({ sessionId, revision, verb, actorId, messageId, input = '', modal = false }) {
  const { buildBoardCustomId } = require('../src/games/discord/boardCustomId');
  const output = { edits: [], replies: [], followUps: [], modals: [], updates: 0 };
  return {
    id: `sweep-board-component-${nextBoardInteraction += 1}`,
    customId: buildBoardCustomId({ sessionId, revision, verb }),
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    message: { id: messageId },
    user: { id: actorId },
    fields: { getTextInputValue: () => input },
    deferred: false,
    replied: false,
    isButton: () => !modal,
    isModalSubmit: () => modal,
    async deferReply() { this.deferred = true; },
    async deferUpdate() { this.deferred = true; output.updates += 1; },
    async showModal(window) { output.modals.push(window); },
    async editReply(payload) { output.edits.push(payload); },
    async reply(payload) { this.replied = true; output.replies.push(payload); },
    async followUp(payload) { output.followUps.push(payload); },
    output,
  };
}

test('the real board runtime serves the start, the buttons and the input window of a board, whatever the guild was recorded as', async () => {
  const { createBoardDiscordRuntime } = require('../src/games/discord/boardDiscordRuntime');
  const { InMemoryBoardStore } = require('./support/inMemoryBoardStore');
  let number = 0;
  for (const [label, record] of STATES) {
    number += 1;
    const before = enterState(record);
    const store = new InMemoryBoardStore();
    store.listRecoverable = async ({ now, limit }) => store.snapshot().sessions
      .filter((session) => ['lobby', 'active'].includes(session.status) && session.expiresAt > now).slice(0, limit);
    const failures = [];
    let generated = 0;
    const runtime = createBoardDiscordRuntime({
      store,
      transport: { async update() {}, async messageExists() { return true; } },
      idFactory: () => `sweep-session-${number}-${generated += 1}`,
      seedFactory: () => `sweep-seed-${number}`,
      clock: () => new Date('2026-09-30T00:00:00.000Z'),
      renderPngImpl: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
      runtimeLogger: { error: (...values) => failures.push(values.map(String).join(' ')), warn() {} },
    });
    try {
      // The start: a game of two, the host and a second member.
      const start = {
        id: `sweep-board-start-${number}`,
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        user: { id: 'sweep-host' },
        options: { getSubcommand: () => 'start', getString: () => 'gomoku' },
        deferred: false,
        replied: false,
        async deferReply() { this.deferred = true; },
        async editReply() {},
        async reply() { this.replied = true; },
        async followUp() {},
        async fetchReply() { return { id: `sweep-board-message-${number}` }; },
      };
      const started = await runtime.executeCommand(start);
      assert.equal(started.session.gameKey, 'gomoku', label);
      let session = await store.getActiveSession({ guildId: GUILD_ID, channelId: CHANNEL_ID });
      await runtime.service.join({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: 'sweep-guest',
        expectedRevision: session.revision, interactionId: `sweep-join-${number}` });
      session = await store.getSessionById(session.id);
      await runtime.service.begin({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: 'sweep-host',
        expectedRevision: session.revision, interactionId: `sweep-begin-${number}` });
      session = await store.getSessionById(session.id);
      assert.equal(session.status, 'active', label);
      const messageId = session.messageId;

      // The button that opens the input window of a move: the window is shown.
      const press = boardComponent({ sessionId: session.id, revision: session.revision, verb: 'act.place',
        actorId: 'sweep-host', messageId });
      assert.equal(await runtime.handleInteraction(press), true, label);
      assert.equal(press.output.modals.length, 1, `${label}: the input window is shown`);

      // The submitted window: the move is made.
      const submit = boardComponent({ sessionId: session.id, revision: session.revision, verb: 'act.place',
        actorId: 'sweep-host', messageId, input: 'H8', modal: true });
      assert.equal(await runtime.handleInteraction(submit), true, label);
      const afterMove = await store.getSessionById(session.id);
      assert.ok(afterMove.revision > session.revision, `${label}: the move is recorded`);
      assert.deepEqual(submit.output.followUps.concat(submit.output.edits).map((payload) => payload.content), ['棋盤已更新。'], label);

      // A plain button of the other member: a draw is offered.
      const offer = boardComponent({ sessionId: session.id, revision: afterMove.revision, verb: 'act.offer-draw',
        actorId: 'sweep-guest', messageId });
      assert.equal(await runtime.handleInteraction(offer), true, label);
      assert.equal(offer.output.updates, 1, label);
      const afterOffer = await store.getSessionById(session.id);
      assert.ok(afterOffer.revision > afterMove.revision, `${label}: the offer is recorded`);

      assert.deepEqual(failures, [], `${label}: nothing was refused`);
      assertAuditUntouched(before, label);
    } finally {
      await runtime.stopLifecycle();
    }
  }
});
