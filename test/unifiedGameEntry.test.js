const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ApplicationCommandOptionType,
  ButtonStyle,
  CommandInteractionOptionResolver,
  ComponentType,
  PermissionFlagsBits,
} = require('discord.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-unified-game-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.BOT_OWNER_ID = 'player';
// Admission data for the guilds that non-owner users play in; read from here instead of src/data.
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');

const { GAME_CATALOG } = require('../website/gameCatalog');
const boardCommand = require('../src/commands/board');
const casinoCommand = require('../src/commands/casino');
const duelCommand = require('../src/commands/duel-tower');
const wordChainCommand = require('../src/commands/word-chain');
const numberChainCommand = require('../src/commands/number-chain');
const casinoLaunch = require('../src/systems/casino/discord/casinoLaunch');
const duelTowerLaunch = require('../src/systems/casino/discord/duelTowerLaunch');
const {
  ensureWordChainAccess,
  launchWordChain,
  startWordChainInChannel,
} = require('../src/systems/community/discord/wordChainLaunch');
const {
  ensureNumberChainAccess,
  launchNumberChain,
  startNumberChainInChannel,
} = require('../src/systems/community/discord/numberChainLaunch');
const gameLaunchCoordinator = require('../src/coordinators/gameLaunchCoordinator');
const { SUPPORTED_START_LAUNCHERS } = require('../src/systems/games/unifiedGameRuntime');
const { catalogStatus, showUnifiedGameStatus } = require('../src/systems/games/unifiedGameRuntime');
const { configureBoardRuntime, resetBoardRuntimeForTests } = require('../src/games/boardRuntimeRegistry');
const { configureSoloRuntime } = require('../src/systems/games/soloRuntimeRegistry');
const { createSoloDiscordRuntime } = require('../src/systems/games/soloDiscordRuntime');
const { createBoardDiscordRuntime } = require('../src/games/discord/boardDiscordRuntime');
const { configureChainReactionFence } = require('../src/systems/safety/chainReactionFence');
const { InMemoryBoardStore } = require('./support/inMemoryBoardStore');
const { applyGameLaunchOnce } = require('../src/systems/games/gameLaunchReceipt');
const { createSoloSessionService } = require('../src/systems/games/soloSessionService');
const {
  BLACKJACK_TTL_MS,
  playBaccarat,
  playDice,
  playPoker,
  playRoulette,
  playSlots,
  startBlackjack,
} = require('../src/services/casinoService');
const { enterDuelTower } = require('../src/services/casinoFacilityService');
const { DEFAULT_SEED } = require('../src/services/wordChainService');
const { DEFAULT_TARGET } = require('../src/services/numberChainService');
const { adjustPlayerBalance } = require('../src/services/coinService');
const { buyChips } = require('../src/services/chipService');
const {
  initializeCoinDatabase,
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const { setGuildFeatureSetting } = require('../src/services/featurePlatformService');
const { openOrGetDailyRiddle } = require('../src/services/dailyRiddleService');
const logger = require('../src/utils/logger');

const WORD_CHANNEL_ID = '71000000000000001';
const NUMBER_CHANNEL_ID = '71000000000000002';
const WORD_DEFAULT_CHANNEL_ID = '71000000000000003';
const NUMBER_DEFAULT_CHANNEL_ID = '71000000000000004';
const FENCE_WORD_CHANNEL_ID = '72000000000000001';
const FENCE_NUMBER_CHANNEL_ID = '72000000000000002';
const PAUSE_WORD_CHANNEL_ID = '72000000000000003';
const PAUSE_NUMBER_CHANNEL_ID = '72000000000000004';
const CORPUS_CHANNEL_ID = '72000000000000005';
const BROKEN_CONFIG_CHANNEL_ID = '72000000000000006';
const SWITCH_WORD_OLD_CHANNEL_ID = '72000000000000007';
const SWITCH_WORD_NEW_CHANNEL_ID = '72000000000000008';
const SWITCH_NUMBER_OLD_CHANNEL_ID = '72000000000000009';
const SWITCH_NUMBER_NEW_CHANNEL_ID = '72000000000000010';
const E2E_WEAPON_ID = 'g_00000000-0000-4000-8000-000000000002';
// Nothing an administrator reads may expose internal codes, stored version labels, file locations, or ledger terms.
const INTERNAL_DETAIL = /REACTION_FENCE|INVALID_CORPUS|unrecognized|corpus|ledger|sqlite|\.json|[A-Za-z]:\\/iu;

function subcommands(command) {
  return command.data.toJSON().options.map((option) => option.name);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// Chain games need an open reaction fence before they can start; the synthetic runtime stands in for the ledger.
function createSyntheticReactionRuntime() {
  const fences = new Map();
  const keyFor = (purposeId, guildId) => `${purposeId}:${guildId}`;
  return {
    isPurposeReady: () => true,
    getLedgerIdentity: (purposeId) => ({ ledgerId: `synthetic-${purposeId}` }),
    getCutoverSourceTimestampMs: () => 0,
    getReactionFence: (purposeId, guildId) => fences.get(keyFor(purposeId, guildId)) || null,
    openReactionFence(purposeId, input) {
      const key = keyFor(purposeId, input.guildId);
      const current = fences.get(key);
      if (current?.open && current.channelId === input.channelId && current.sessionKey === input.sessionKey) {
        return { kind: 'existing', fence: current };
      }
      const fence = Object.freeze({
        generation: current ? current.generation + 1 : 1,
        channelId: input.channelId,
        sessionKey: input.sessionKey,
        sourceFence: crypto.createHash('sha256').update(`${key}:${input.sessionKey}`).digest('hex'),
        open: true,
      });
      fences.set(key, fence);
      return { kind: 'opened', fence };
    },
    closeReactionFence(purposeId, guildId, expected = {}) {
      const key = keyFor(purposeId, guildId);
      const current = fences.get(key);
      if (!current) return { kind: 'missing', fence: null };
      if ((expected.channelId !== undefined && expected.channelId !== current.channelId) ||
          (expected.generation !== undefined && expected.generation !== current.generation)) {
        return { kind: 'stale', fence: current };
      }
      const fence = Object.freeze({ ...current, open: false });
      fences.set(key, fence);
      return { kind: 'closed', fence };
    },
    verifyReactionFence(purposeId, input) {
      const current = fences.get(keyFor(purposeId, input.guildId));
      if (!current || !current.open || current.generation !== input.generation ||
          current.channelId !== input.channelId || current.sessionKey !== input.sessionKey ||
          current.sourceFence !== input.sourceFence) return null;
      return current;
    },
  };
}

const syntheticReactionRuntime = createSyntheticReactionRuntime();
configureChainReactionFence(syntheticReactionRuntime);

async function captureWarnings(run) {
  const warnings = [];
  const originalWarn = logger.warn;
  logger.warn = (message) => { warnings.push(String(message)); };
  try {
    await run();
  } finally {
    logger.warn = originalWarn;
  }
  return warnings;
}

async function ensureDatabase() {
  if (!fs.existsSync(process.env.COIN_DB_PATH)) {
    await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  }
}

async function fundPlayer(userId = 'player', guildId = 'guild') {
  await ensureDatabase();
  await adjustPlayerBalance(guildId, userId, {
    action: 'add', amount: 500, operatorId: 'admin', reason: 'synthetic fixture',
  });
  await buyChips(guildId, userId, 200);
}

async function seedBattleWeapon(userId, itemId) {
  await withCoinTransaction((api) => {
    const timestamp = new Date('2026-09-30T03:00:00.000Z').toISOString();
    api.run(`INSERT OR IGNORE INTO coin_global_shop_items
      (id,name,description,price,type,enabled,deleted,stock,purchase_limit,created_by,source_guild_id,created_at,updated_at)
      VALUES (?,?,?,?,?,1,0,NULL,NULL,?,?,?,?)`,
    [itemId, '合成鐵劍', 'synthetic fixture', 100, 'battle_item', 'admin', 'guild', timestamp, timestamp]);
    api.run(`INSERT OR IGNORE INTO coin_global_inventory (user_id,item_id,item_name,quantity,acquired_at,updated_at)
      VALUES (?,?,?,?,?,?)`, [userId, itemId, '合成鐵劍', 1, timestamp, timestamp]);
  });
}

// A /board <subcommand> interaction built on the real discord.js option resolver, so required-option errors and
// option types behave as they do in Discord. Only the reply methods are recorded fakes.
function createBoardInteraction({ id, subcommand = 'start', values = {}, userId = 'player', guildId = 'guild',
  channelId = 'room', client = {} }) {
  const data = Object.entries(values).map(([name, value]) => ({
    type: typeof value === 'number' ? ApplicationCommandOptionType.Integer : ApplicationCommandOptionType.String,
    name,
    value,
  }));
  const log = { replies: [], deferred: [], edits: [], followUps: [] };
  const channel = {
    id: channelId,
    isTextBased: () => true,
    send: async () => ({ id: 'sent-message' }),
    permissionsFor: () => ({ has: () => true }),
  };
  const interaction = {
    id,
    client,
    guildId,
    channelId,
    channel,
    commandName: 'board',
    user: { id: userId, toString: () => `<@${userId}>` },
    guild: { id: guildId, members: { me: {}, fetch: async () => ({ permissions: { has: () => true } }) } },
    memberPermissions: { has: () => true },
    deferred: false,
    replied: false,
    inGuild: () => true,
    options: new CommandInteractionOptionResolver(client, [{
      type: ApplicationCommandOptionType.Subcommand, name: subcommand, options: data,
    }], {}),
    async reply(payload) { this.replied = true; log.replies.push(payload); return payload; },
    async deferReply(payload) { this.deferred = true; log.deferred.push(payload ?? null); },
    async editReply(payload) { this.replied = true; log.edits.push(payload); return payload; },
    async followUp(payload) { log.followUps.push(payload); return payload; },
    async fetchReply() { return { id: `${id}-message` }; },
  };
  return { interaction, log };
}

async function useBoardRuntime(overrides = {}) {
  await resetBoardRuntimeForTests();
  return configureBoardRuntime({
    executeCommand: async () => null,
    handleInteraction: async () => null,
    startLifecycle: async () => null,
    stopLifecycle: async () => null,
    service: { status: async () => { throw Object.assign(new Error('no board'), { code: 'SESSION_NOT_FOUND' }); } },
    ...overrides,
  });
}

async function launchState() {
  return withCoinDatabase((api) => ({
    receipts: Number(api.get('SELECT COUNT(*) AS count FROM game_launch_receipts').count),
    games: Number(api.get('SELECT COUNT(*) AS count FROM casino_games').count),
    duels: Number(api.get('SELECT COUNT(*) AS count FROM casino_duel_tower_runs').count),
    ledger: Number(api.get('SELECT COUNT(*) AS count FROM casino_ledger').count),
  }));
}

async function launchReceipt(interactionId) {
  return withCoinDatabase((api) => api.get(
    'SELECT kind, user_id, guild_id FROM game_launch_receipts WHERE interaction_id = ?', [interactionId],
  ));
}

function createRiddleFixture(prefix, now) {
  const counters = { sends: 0, threads: 0 };
  const guildId = `${prefix}-guild`;
  const parentId = `${prefix}-parent`;
  const threadId = `${prefix}-thread`;
  const thread = { id: threadId, messages: { fetch: async () => [] }, send: async () => ({ id: `${prefix}-answer` }) };
  const parent = {
    id: parentId,
    messages: { fetch: async () => [] },
    async send(payload) {
      counters.sends += 1;
      return {
        id: `${prefix}-announcement`, payload, author: { id: 'bot' }, createdAt: now,
        async startThread() { counters.threads += 1; return thread; },
      };
    },
  };
  const guild = { id: guildId, channels: { cache: new Map([[parentId, parent], [threadId, thread]]),
    fetch: async (id) => id === parentId ? parent : id === threadId ? thread : null } };
  const client = { user: { id: 'bot' }, guilds: { cache: new Map([[guildId, guild]]) },
    channels: { cache: new Map() } };
  return { client, counters, guildId, parentId, threadId };
}

test.after(() => {
  resetCoinDatabaseForTests();
  return resetBoardRuntimeForTests().finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
});

test('board 是 19 款遊戲的唯一開局入口，舊開局子命令不再註冊', () => {
  const json = boardCommand.data.toJSON();
  const start = json.options.find((option) => option.name === 'start');
  const status = json.options.find((option) => option.name === 'status');
  const choices = start.options.find((option) => option.name === 'game').choices;
  assert.equal(GAME_CATALOG.length, 19);
  assert.deepEqual(choices.map((choice) => choice.value), GAME_CATALOG.map((game) => game.key));
  assert.deepEqual(status.options[0].choices.map((choice) => choice.value), GAME_CATALOG.map((game) => game.key));
  assert.ok(GAME_CATALOG.every((game) => SUPPORTED_START_LAUNCHERS.has(game.launcher)));
  assert.equal(GAME_CATALOG.some((game) => ['roll', 'fortune'].includes(game.key)), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'commands', 'games.js')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'commands', 'roll.js')), true);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'commands', 'fortune.js')), true);
  assert.deepEqual(subcommands(casinoCommand), ['loan-borrow', 'loan-repay', 'loan-status', 'history']);
  assert.deepEqual(subcommands(duelCommand), ['weapons', 'profile', 'history']);
  assert.deepEqual(subcommands(wordChainCommand), ['stop', 'status']);
  assert.deepEqual(subcommands(numberChainCommand), ['stop', 'status']);
});

test('開局收據與遊戲資料同交易提交，重播不重複扣款或建局，異參數會拒絕', async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  await adjustPlayerBalance('guild', 'player', {
    action: 'add', amount: 200, operatorId: 'admin', reason: 'synthetic fixture',
  });
  await buyChips('guild', 'player', 100);

  const first = await playDice('guild', 'player', {
    amount: 10, choice: 'big', interactionId: 'casino-launch', rng: () => 5,
  });
  const replay = await playDice('guild', 'player', {
    amount: 10, choice: 'big', interactionId: 'casino-launch', rng: () => 0,
  });
  assert.equal(first.alreadyApplied, false);
  assert.equal(replay.alreadyApplied, true);
  assert.deepEqual(replay.game, first.game);
  await assert.rejects(() => playDice('guild', 'player', {
    amount: 11, choice: 'big', interactionId: 'casino-launch', rng: () => 0,
  }), (error) => error.code === 'OPERATION_CONFLICT');

  let generated = 0;
  const solo = createSoloSessionService({
    withDatabase: withCoinDatabase,
    withTransaction: withCoinTransaction,
    idFactory: () => `solo-${++generated}`,
    seedFactory: () => 'solo-seed',
    clock: () => new Date('2026-09-30T03:00:00.000Z'),
  });
  const soloFirst = await solo.create({ userId: 'player', guildId: 'guild', channelId: 'room',
    gameType: 'sudoku', difficulty: 'easy', interactionId: 'solo-launch' });
  const soloReplay = await solo.create({ userId: 'player', guildId: 'guild', channelId: 'room',
    gameType: 'sudoku', difficulty: 'easy', interactionId: 'solo-launch' });
  assert.equal(soloFirst.alreadyApplied, false);
  assert.equal(soloReplay.alreadyApplied, true);
  assert.equal(soloReplay.id, soloFirst.id);
  await assert.rejects(() => solo.create({ userId: 'player', guildId: 'guild', channelId: 'room',
    gameType: 'sudoku', difficulty: 'hard', interactionId: 'solo-launch' }),
  (error) => error.code === 'OPERATION_CONFLICT');

  const weaponId = 'g_00000000-0000-4000-8000-000000000001';
  await withCoinTransaction((api) => {
    const timestamp = new Date('2026-09-30T03:00:00.000Z').toISOString();
    api.run(`INSERT INTO coin_global_shop_items
      (id,name,description,price,type,enabled,deleted,stock,purchase_limit,created_by,source_guild_id,created_at,updated_at)
      VALUES (?,?,?,?,?,1,0,NULL,NULL,?,?,?,?)`,
    [weaponId, '合成木劍', 'synthetic fixture', 100, 'battle_item', 'admin', 'guild', timestamp, timestamp]);
    api.run(`INSERT INTO coin_global_inventory (user_id,item_id,item_name,quantity,acquired_at,updated_at)
      VALUES (?,?,?,?,?,?)`, ['player', weaponId, '合成木劍', 1, timestamp, timestamp]);
  });
  const duelFirst = await enterDuelTower('guild', 'player', {
    weaponItemId: weaponId, wager: 5, interactionId: 'duel-launch', rng: () => 0,
  });
  const duelReplay = await enterDuelTower('guild', 'player', {
    weaponItemId: weaponId, wager: 5, interactionId: 'duel-launch', rng: () => 59,
  });
  assert.equal(duelFirst.alreadyApplied, false);
  assert.equal(duelReplay.alreadyApplied, true);
  assert.deepEqual(duelReplay.run, duelFirst.run);
  await assert.rejects(() => enterDuelTower('guild', 'player', {
    weaponItemId: weaponId, wager: 6, interactionId: 'duel-launch', rng: () => 0,
  }), (error) => error.code === 'OPERATION_CONFLICT');

  await assert.rejects(() => withCoinTransaction((api) => applyGameLaunchOnce(api, {
    interactionId: 'failed-launch', kind: 'synthetic', userId: 'player', guildId: 'guild', payload: { value: 1 },
  }, () => {
    api.run('INSERT INTO feature_health (feature_key, status, updated_at) VALUES (?, ?, ?)',
      ['synthetic_failure', 'normal', new Date().toISOString()]);
    throw new Error('synthetic transaction failure');
  })), /synthetic transaction failure/u);

  const rows = await withCoinDatabase((api) => ({
    version: api.get("SELECT value FROM coin_metadata WHERE key = 'schema_version'").value,
    games: api.get("SELECT COUNT(*) AS count FROM casino_games WHERE user_id = 'player'").count,
    sessions: api.get("SELECT COUNT(*) AS count FROM discord_game_sessions WHERE user_id = 'player'").count,
    duels: api.get("SELECT COUNT(*) AS count FROM casino_duel_tower_runs WHERE user_id = 'player'").count,
    receipts: api.get('SELECT COUNT(*) AS count FROM game_launch_receipts').count,
    failedSideEffect: api.get("SELECT COUNT(*) AS count FROM feature_health WHERE feature_key = 'synthetic_failure'").count,
  }));
  assert.deepEqual(rows, { version: '24', games: 1, sessions: 1, duels: 1, receipts: 3, failedSideEffect: 0 });

  resetCoinDatabaseForTests();
  const reopened = await initializeCoinDatabase();
  assert.equal(reopened.schemaVersion, 24);
  assert.equal(await withCoinDatabase((api) =>
    api.get('SELECT COUNT(*) AS count FROM game_launch_receipts').count), 3);

  await withCoinTransaction((api) => {
    api.run('DROP TABLE game_launch_receipts');
    api.run("UPDATE coin_metadata SET value = '22' WHERE key = 'schema_version'");
  });
  resetCoinDatabaseForTests();
  const migrated = await initializeCoinDatabase();
  assert.equal(migrated.schemaVersion, 24);
  assert.deepEqual(await withCoinDatabase((api) =>
    api.all('PRAGMA table_info(game_launch_receipts)').map((column) => column.name)),
  ['interaction_id', 'kind', 'user_id', 'guild_id', 'channel_id', 'payload_hash', 'result_json', 'created_at']);
});

test('每日猜謎開局沿用同日事件，併發與重播只發布一次且不憑開局發獎', async () => {
  const now = new Date('2026-09-30T03:00:00.000Z'); // 台北 11:00
  await setGuildFeatureSetting('riddle-guild', 'daily_riddle', {
    enabled: true, channelId: 'riddle-parent', now,
  });
  let sends = 0;
  let threads = 0;
  const thread = { id: 'riddle-thread', messages: { fetch: async () => [] }, send: async () => ({ id: 'answer' }) };
  const parent = {
    id: 'riddle-parent',
    messages: { fetch: async () => [] },
    async send(payload) {
      sends += 1;
      return {
        id: 'riddle-announcement', payload, author: { id: 'bot' }, createdAt: now,
        async startThread() { threads += 1; return thread; },
      };
    },
  };
  const guild = { id: 'riddle-guild', channels: { cache: new Map([['riddle-parent', parent], ['riddle-thread', thread]]),
    fetch: async (id) => id === 'riddle-parent' ? parent : id === 'riddle-thread' ? thread : null } };
  const client = { user: { id: 'bot' }, guilds: { cache: new Map([['riddle-guild', guild]]) },
    channels: { cache: new Map() } };

  const results = await Promise.all([
    openOrGetDailyRiddle(client, { guildId: 'riddle-guild', now }),
    openOrGetDailyRiddle(client, { guildId: 'riddle-guild', now }),
  ]);
  const repeated = await openOrGetDailyRiddle(client, { guildId: 'riddle-guild', now });
  assert.equal(sends, 1);
  assert.equal(threads, 1);
  assert.ok(results.some((result) => result.event?.threadId === 'riddle-thread'));
  assert.equal(repeated.event.threadId, 'riddle-thread');

  await setGuildFeatureSetting('cutoff-guild', 'daily_riddle', {
    enabled: true, channelId: 'cutoff-parent', now,
  });
  const cutoff = await openOrGetDailyRiddle(client, {
    guildId: 'cutoff-guild', now: new Date('2026-09-30T14:00:00.000Z'),
  });
  const disabled = await openOrGetDailyRiddle(client, { guildId: 'disabled-guild', now });
  assert.equal(cutoff.code, 'RIDDLE_CLOSED');
  assert.equal(disabled.code, 'RIDDLE_DISABLED');

  const rows = await withCoinDatabase((api) => ({
    events: api.get("SELECT COUNT(*) AS count FROM daily_events WHERE guild_id = 'riddle-guild'").count,
    cutoffEvents: api.get("SELECT COUNT(*) AS count FROM daily_events WHERE guild_id = 'cutoff-guild'").count,
    participants: api.get('SELECT COUNT(*) AS count FROM daily_event_participants').count,
    rewards: api.get("SELECT COUNT(*) AS count FROM reward_grants WHERE source_type = 'daily_riddle'").count,
  }));
  assert.deepEqual(rows, { events: 1, cutoffEvents: 0, participants: 0, rewards: 0 });
});

test('board status 只以查詢者與目前頻道尋找公開局及個人局', async () => {
  let boardScope = null;
  let soloScope = null;
  let statusError = null;
  configureBoardRuntime({
    executeCommand: async () => null,
    handleInteraction: async () => null,
    startLifecycle: async () => null,
    stopLifecycle: async () => null,
    service: { status: async (scope) => {
      boardScope = scope;
      if (statusError) throw statusError;
      return { session: { gameKey: 'gomoku' } };
    } },
  });
  configureSoloRuntime({
    executeCommand: async () => null,
    handleInteraction: async () => null,
    resume: async () => null,
    service: { findLatest: async (scope) => {
      soloScope = scope;
      return { gameType: 'sudoku' };
    } },
  });
  let response = null;
  const interaction = {
    deferred: true,
    guildId: 'guild', channelId: 'room', user: { id: 'player' }, inGuild: () => true,
    options: { getString: () => null },
    editReply: async (payload) => { response = payload; return payload; },
  };
  await catalogStatus(interaction);
  assert.deepEqual(boardScope, { guildId: 'guild', channelId: 'room', actorId: 'player' });
  assert.deepEqual(soloScope, { actorId: 'player', guildId: 'guild', channelId: 'room' });
  assert.match(response.content, /目前頻道公開局/u);
  assert.match(response.content, /你的個人局/u);
  assert.doesNotMatch(response.content, /其他使用者/u);

  statusError = Object.assign(new Error('internal session lookup detail'), { code: 'SESSION_NOT_FOUND' });
  interaction.options.getString = () => 'gomoku';
  await showUnifiedGameStatus(interaction);
  assert.equal(response.content, '目前頻道沒有這個公開遊戲。');
  assert.doesNotMatch(response.content, /internal|SESSION_NOT_FOUND/u);
});

test('board status 目錄查詢先私密 defer、再查詢，並只以 editReply 回覆', async () => {
  const order = [];
  await useBoardRuntime({ service: { status: async () => {
    order.push('board lookup');
    throw Object.assign(new Error('no public board'), { code: 'SESSION_NOT_FOUND' });
  } } });
  configureSoloRuntime({
    executeCommand: async () => null,
    handleInteraction: async () => null,
    resume: async () => null,
    service: { findLatest: async () => { order.push('solo lookup'); return null; } },
  });
  const { interaction, log } = createBoardInteraction({ id: 'status-defer', subcommand: 'status' });
  const deferReply = interaction.deferReply.bind(interaction);
  interaction.deferReply = async (payload) => { order.push('defer'); return deferReply(payload); };

  await boardCommand.execute(interaction);

  assert.deepEqual(order.slice(0, 3), ['defer', 'board lookup', 'solo lookup']);
  assert.deepEqual(log.deferred, [{ ephemeral: true }]);
  assert.equal(log.replies.length, 0);
  assert.equal(log.followUps.length, 0);
  assert.equal(log.edits.length, 1);
  assert.match(log.edits[0].content, /小吉遊戲目錄/u);
  assert.match(log.edits[0].content, /目前沒有/u);
});

test('board status 在 defer 之後失敗時，仍以 editReply 回覆友善訊息，不另開回覆', async () => {
  await useBoardRuntime();
  const { interaction, log } = createBoardInteraction({ id: 'status-failure', subcommand: 'status' });
  const editReply = interaction.editReply.bind(interaction);
  let attempts = 0;
  interaction.editReply = async (payload) => {
    attempts += 1;
    if (attempts === 1) throw new Error('synthetic edit failure with internal detail');
    return editReply(payload);
  };

  const result = await boardCommand.execute(interaction);

  assert.deepEqual(result, { ok: false, code: 'STATUS_FAILED' });
  assert.equal(attempts, 2);
  assert.deepEqual(log.deferred, [{ ephemeral: true }]);
  assert.deepEqual(log.edits.map((payload) => payload.content), ['查詢遊戲狀態失敗，請稍後再試。']);
  assert.equal(log.replies.length, 0);
  assert.equal(log.followUps.length, 0);
});

test('board start 缺少賭場或決鬥塔的必要選項時，私密說明缺哪個選項，且不開始任何交易', async () => {
  await fundPlayer();
  await seedBattleWeapon('player', E2E_WEAPON_ID);
  const cases = [
    { game: 'casino-dice', values: {}, missing: ['amount', 'choice'] },
    { game: 'casino-dice', values: { amount: 5 }, missing: ['choice'] },
    { game: 'casino-dice', values: { choice: 'big' }, missing: ['amount'] },
    { game: 'casino-slots', values: {}, missing: ['amount'] },
    { game: 'casino-blackjack', values: {}, missing: ['amount'] },
    { game: 'casino-roulette', values: { amount: 5 }, missing: ['choice'] },
    { game: 'casino-baccarat', values: { amount: 5 }, missing: ['choice'] },
    { game: 'casino-poker', values: {}, missing: ['amount'] },
    { game: 'duel-tower', values: {}, missing: ['weapon-item-id', 'wager'] },
    { game: 'duel-tower', values: { 'weapon-item-id': E2E_WEAPON_ID }, missing: ['wager'] },
    { game: 'duel-tower', values: { wager: 5 }, missing: ['weapon-item-id'] },
  ];
  const errors = [];
  const originalError = logger.error;
  logger.error = (...args) => { errors.push(args); };
  try {
    for (const [index, entry] of cases.entries()) {
      const label = `${entry.game} ${JSON.stringify(entry.values)}`;
      const before = await launchState();
      const { interaction, log } = createBoardInteraction({
        id: `missing-parameter-${index}`, values: { game: entry.game, ...entry.values },
      });

      const result = await boardCommand.execute(interaction);

      assert.deepEqual(result, { ok: false, code: 'MISSING_PARAMETER', missing: entry.missing }, label);
      assert.equal(log.replies.length, 1, label);
      assert.equal(log.replies[0].ephemeral, true, label);
      const text = log.replies[0].content;
      assert.ok(text.includes(GAME_CATALOG.find((game) => game.key === entry.game).name), label);
      for (const name of entry.missing) assert.ok(text.includes(`${name}（`), `${label}: ${text}`);
      for (const name of Object.keys(entry.values)) assert.equal(text.includes(`${name}（`), false, `${label}: ${text}`);
      assert.doesNotMatch(text, /稍後再試|失敗/u, label);
      assert.deepEqual(await launchState(), before, label);
      assert.equal(await launchReceipt(interaction.id), null, label);
    }
  } finally {
    logger.error = originalError;
  }
  assert.deepEqual(errors, []);
});

test('從 /board start 進入賭場：六款遊戲各自分派到對應服務並留下開局收據', async () => {
  await fundPlayer();
  const cases = [
    { game: 'casino-dice', values: { amount: 1, choice: 'big' }, kind: 'casino-dice', pattern: /小吉賭場｜骰子/u },
    { game: 'casino-slots', values: { amount: 1 }, kind: 'casino-slots', pattern: /小吉賭場｜角子機/u },
    { game: 'casino-roulette', values: { amount: 1, choice: 'red' }, kind: 'casino-roulette', pattern: /小吉賭場｜輪盤/u },
    { game: 'casino-baccarat', values: { amount: 1, choice: 'player' }, kind: 'casino-baccarat', pattern: /小吉賭場｜百家樂/u },
    { game: 'casino-poker', values: { amount: 1 }, kind: 'casino-poker', pattern: /小吉賭場｜撲克牌/u },
    { game: 'casino-blackjack', values: { amount: 1 }, kind: 'casino-blackjack', pattern: /21 點/u },
  ];
  for (const entry of cases) {
    const before = await launchState();
    const { interaction, log } = createBoardInteraction({
      id: `e2e-${entry.game}`, values: { game: entry.game, ...entry.values },
    });

    await boardCommand.execute(interaction);

    assert.equal(log.replies.length, 1, entry.game);
    assert.notEqual(log.replies[0].ephemeral, true, entry.game);
    assert.match(log.replies[0].content, entry.pattern, entry.game);
    assert.deepEqual(await launchReceipt(interaction.id), { kind: entry.kind, user_id: 'player', guild_id: 'guild' },
      entry.game);
    const after = await launchState();
    assert.equal(after.receipts, before.receipts + 1, entry.game);
    if (entry.game !== 'casino-blackjack') assert.equal(after.games, before.games + 1, entry.game);
  }
});

test('從 /board start 進入決鬥塔台：以武器與下注籌碼開一場挑戰並留下開局收據', async () => {
  await fundPlayer();
  await seedBattleWeapon('player', E2E_WEAPON_ID);
  const before = await launchState();
  const { interaction, log } = createBoardInteraction({
    id: 'e2e-duel-tower', values: { game: 'duel-tower', 'weapon-item-id': E2E_WEAPON_ID, wager: 2 },
  });

  await boardCommand.execute(interaction);

  assert.equal(log.replies.length, 1);
  assert.notEqual(log.replies[0].ephemeral, true);
  assert.match(log.replies[0].content, /決鬥塔台｜挑戰結算/u);
  assert.deepEqual(await launchReceipt(interaction.id), { kind: 'duel-tower', user_id: 'player', guild_id: 'guild' });
  const after = await launchState();
  assert.equal(after.receipts, before.receipts + 1);
  assert.equal(after.duels, before.duels + 1);
});

test('/board 的啟動分派是協調者：舊路徑 unifiedGameRuntime 只是一行轉接，載入的就是協調者本身', () => {
  const oldPath = require('../src/systems/games/unifiedGameRuntime');
  assert.ok(oldPath === gameLaunchCoordinator);
  assert.deepEqual(Object.keys(gameLaunchCoordinator).sort(),
    ['SUPPORTED_START_LAUNCHERS', 'assertGuildChannel', 'catalogStatus', 'endOwnSoloGame', 'showUnifiedGameStatus', 'startUnifiedGame']);
  // A regular expression, not the text itself: the export check reads every require('...') it finds in a test file,
  // string or not, as a dependency of that file.
  assert.match(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'systems', 'games', 'unifiedGameRuntime.js'), 'utf8'),
    /^module\.exports = require\('\.\.\/\.\.\/coordinators\/gameLaunchCoordinator'\);\n$/u,
  );
});

test('賭場與決鬥塔台的啟動函式實作在 systems 模組，指令檔的相容匯出與新模組是同一個函式', () => {
  assert.equal(typeof casinoLaunch.executeCasinoGame, 'function');
  assert.equal(typeof duelTowerLaunch.executeDuelTowerGame, 'function');
  assert.ok(casinoCommand.executeCasinoGame === casinoLaunch.executeCasinoGame);
  assert.ok(duelCommand.executeDuelTowerGame === duelTowerLaunch.executeDuelTowerGame);
});

// The two ways into a launch: /board start (through unifiedGameRuntime) and the launcher that the casino and duel-tower
// command files export under their old names. A launch is recorded under its interaction id, so the same id sent
// through both paths makes the second one a replay of the first: the random outcome is fixed and the replies can be
// compared exactly. The two orders cover each path both as the real run and as the replay.
const LAUNCH_PARITY_CASES = [
  { game: 'casino-dice', values: { amount: 1, choice: 'big' }, pattern: /小吉賭場｜骰子/u },
  { game: 'casino-slots', values: { amount: 1 }, pattern: /小吉賭場｜角子機/u },
  { game: 'casino-roulette', values: { amount: 1, choice: 'red' }, pattern: /小吉賭場｜輪盤/u },
  { game: 'casino-baccarat', values: { amount: 1, choice: 'player' }, pattern: /小吉賭場｜百家樂/u },
  { game: 'casino-poker', values: { amount: 1 }, pattern: /小吉賭場｜撲克牌/u },
  { game: 'casino-blackjack', values: { amount: 1 }, pattern: /21 點/u },
  { game: 'duel-tower', values: { 'weapon-item-id': E2E_WEAPON_ID, wager: 2 }, pattern: /決鬥塔台｜挑戰結算/u },
];

function launchThroughCommandFile(interaction, game) {
  return game === 'duel-tower'
    ? duelCommand.executeDuelTowerGame(interaction)
    : casinoCommand.executeCasinoGame(interaction, game);
}

// Everything the command did to the interaction, with embeds and buttons reduced to the JSON Discord receives.
function receivedFromLaunch(log) {
  return JSON.parse(JSON.stringify(log));
}

function buttonCustomIds(reply) {
  return (reply.components || []).flatMap((row) => row.components.map((button) => button.custom_id));
}

test('賭場六款遊戲與決鬥塔台：/board start 與指令檔匯出的啟動函式回覆一致（內容、ephemeral、元件、customId）', async () => {
  for (const order of ['board-first', 'command-first']) {
    // One open blackjack session is allowed per player and guild, so each order plays in its own guild.
    const guildId = `parity-${order}`;
    await fundPlayer('player', guildId);
    await seedBattleWeapon('player', E2E_WEAPON_ID);
    for (const entry of LAUNCH_PARITY_CASES) {
      const label = `${order} ${entry.game}`;
      const id = `parity-${order}-${entry.game}`;
      const launchers = {
        board: async () => {
          const { interaction, log } = createBoardInteraction({ id, guildId, values: { game: entry.game, ...entry.values } });
          await boardCommand.execute(interaction);
          return receivedFromLaunch(log);
        },
        command: async () => {
          const { interaction, log } = createBoardInteraction({ id, guildId, values: entry.values });
          await launchThroughCommandFile(interaction, entry.game);
          return receivedFromLaunch(log);
        },
      };
      const [firstPath, secondPath] = order === 'board-first' ? ['board', 'command'] : ['command', 'board'];
      const before = await launchState();

      const first = await launchers[firstPath]();
      const afterFirst = await launchState();
      const second = await launchers[secondPath]();
      const afterSecond = await launchState();

      assert.equal(afterFirst.receipts, before.receipts + 1, label);
      assert.deepEqual(afterSecond, afterFirst, label);
      assert.deepEqual(await launchReceipt(id), { kind: entry.game, user_id: 'player', guild_id: guildId }, label);
      const received = { [firstPath]: first, [secondPath]: second };
      assert.equal(received.board.replies.length, 1, label);
      assert.deepEqual(received.command, received.board, label);
      const boardReply = received.board.replies[0];
      const commandReply = received.command.replies[0];
      assert.match(boardReply.content, entry.pattern, label);
      assert.notEqual(boardReply.ephemeral, true, label);
      assert.equal(commandReply.ephemeral, boardReply.ephemeral, label);
      assert.deepEqual(buttonCustomIds(commandReply), buttonCustomIds(boardReply), label);
      if (entry.game === 'casino-blackjack') {
        const customIds = buttonCustomIds(boardReply);
        assert.ok(customIds.length > 0, label);
        assert.ok(customIds.every((customId) => customId.startsWith('casino:blackjack:')), label);
      }
    }
  }
});

// What a person reads when a casino game or the duel tower is launched, line by line. The comparison above shows that
// the two ways in agree with each other, and only on the title; this one fixes the numbers. Each outcome is fixed
// first: the game is played through its service with a fixed random source (or deck) and a fixed clock, under the
// interaction id the launch then uses. The launch finds that stored outcome and replays it, so the reply is built from
// known numbers and must read exactly as written here, whichever way in the person came.
const FIXED_CLOCK = new Date('2026-09-30T00:00:00.000Z');
const DECK_SUITS = ['S', 'H', 'D', 'C'];
const DECK_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// A random source that hands out exactly the listed numbers, and fails if the game asks for more.
function scriptedRng(values) {
  let index = 0;
  return () => {
    assert.ok(index < values.length, 'the game asked for more random numbers than the test scripted');
    return values[index++];
  };
}

// A whole deck, in the order the service builds it, with the given cards moved to the top.
function deckWithTop(topCards) {
  assert.equal(new Set(topCards).size, topCards.length);
  const all = DECK_SUITS.flatMap((suit) => DECK_RANKS.map((rank) => `${rank}${suit}`));
  return [...topCards, ...all.filter((card) => !topCards.includes(card))];
}

// The random source of a game that shuffles its own deck, chosen so that the shuffle leaves the given cards on top
// (the same construction as in test/baccaratRules.test.js).
function rngForTopCards(topCards) {
  const target = deckWithTop(topCards);
  const working = deckWithTop([]);
  const swaps = [];
  for (let index = working.length - 1; index > 0; index -= 1) {
    const swapIndex = working.indexOf(target[index]);
    assert.ok(swapIndex <= index);
    swaps.push(swapIndex);
    [working[index], working[swapIndex]] = [working[swapIndex], working[index]];
  }
  assert.deepEqual(working, target);
  let call = 0;
  return (maxExclusive) => {
    assert.equal(maxExclusive, 52 - call);
    return swaps[call++];
  };
}

// Chips and coins belong to the person across guilds, so each case plays as its own person, in its own guild.
async function fundFixedLaunch(guildId, userId, { coins, chips }) {
  await adjustPlayerBalance(guildId, userId, {
    action: 'add', amount: coins, operatorId: 'admin', reason: 'synthetic fixture',
  });
  await buyChips(guildId, userId, chips);
}

const textReply = (lines) => () => ({ content: lines.join('\n') });

// The blackjack panel: `content` is what the launcher adds above it, given the mention of the person.
function blackjackReply({ content, color, description, status, payout, player, dealer, disabled }) {
  return (played, userId) => {
    const sessionId = played.session.id;
    return {
      content: content(`<@${userId}>`),
      embeds: [{
        color,
        title: `小吉賭場｜21點 #${sessionId}`,
        description,
        fields: [
          { name: '下注', value: '10 籌碼', inline: true },
          { name: '狀態', value: status, inline: true },
          { name: '派彩', value: payout, inline: true },
          { name: '你的手牌', value: player, inline: false },
          { name: '莊家手牌', value: dealer, inline: false },
        ],
      }],
      components: [{
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.Button, custom_id: `casino:blackjack:hit:${sessionId}`, label: '補牌', style: ButtonStyle.Primary, disabled },
          { type: ComponentType.Button, custom_id: `casino:blackjack:stand:${sessionId}`, label: '停牌', style: ButtonStyle.Secondary, disabled },
        ],
      }],
      allowedMentions: { parse: [] },
    };
  };
}

const FIXED_LAUNCHES = [
  {
    key: 'dice-hit',
    game: 'casino-dice',
    values: { amount: 10, choice: 'big' },
    funds: { coins: 500, chips: 200 },
    play: (guildId, userId, interactionId) => playDice(guildId, userId, {
      amount: 10, choice: 'big', rng: scriptedRng([5, 5]), date: FIXED_CLOCK, interactionId,
    }),
    reply: textReply([
      '**小吉賭場｜骰子**',
      '選擇：大',
      '骰面：6 + 6 = 12',
      '結果：命中',
      '下注：10 籌碼',
      '派彩：20 籌碼',
      '本局損益：+10 籌碼',
      '籌碼餘額：210 籌碼',
    ]),
  },
  {
    key: 'dice-miss-with-top-up',
    game: 'casino-dice',
    values: { amount: 10, choice: 'small' },
    funds: { coins: 100, chips: 4 },
    play: (guildId, userId, interactionId) => playDice(guildId, userId, {
      amount: 10, choice: 'small', rng: scriptedRng([5, 5]), date: FIXED_CLOCK, interactionId,
    }),
    reply: textReply([
      '**小吉賭場｜骰子**',
      '選擇：小',
      '骰面：6 + 6 = 12',
      '結果：未命中',
      '下注：10 籌碼',
      '派彩：0 籌碼',
      '本局損益：-10 籌碼',
      '籌碼餘額：0 籌碼',
      '籌碼不足，已自動用吉幣兌換 6 籌碼。',
    ]),
  },
  {
    key: 'slots-three-sevens',
    game: 'casino-slots',
    values: { amount: 5 },
    funds: { coins: 500, chips: 200 },
    play: (guildId, userId, interactionId) => playSlots(guildId, userId, {
      amount: 5, rng: scriptedRng([4, 4, 4]), date: FIXED_CLOCK, interactionId,
    }),
    reply: textReply([
      '**小吉賭場｜角子機**',
      '盤面：七 | 七 | 七',
      '結果：中獎',
      '下注：5 籌碼',
      '派彩：50 籌碼',
      '本局損益：+45 籌碼',
      '籌碼餘額：245 籌碼',
    ]),
  },
  {
    key: 'roulette-black',
    game: 'casino-roulette',
    values: { amount: 10, choice: 'black' },
    funds: { coins: 500, chips: 200 },
    play: (guildId, userId, interactionId) => playRoulette(guildId, userId, {
      amount: 10, choice: 'black', rng: scriptedRng([17]), date: FIXED_CLOCK, interactionId,
    }),
    reply: textReply([
      '**小吉賭場｜輪盤**',
      '選擇：黑色',
      '結果：17（黑色）',
      '狀態：命中',
      '下注：10 籌碼',
      '派彩：20 籌碼',
      '本局損益：+10 籌碼',
      '籌碼餘額：210 籌碼',
    ]),
  },
  {
    key: 'baccarat-player-natural',
    game: 'casino-baccarat',
    values: { amount: 10, choice: 'player' },
    funds: { coins: 500, chips: 200 },
    play: (guildId, userId, interactionId) => playBaccarat(guildId, userId, {
      amount: 10,
      choice: 'player',
      rng: rngForTopCards(['8S', '4D', '10H', 'JC', '9S']),
      date: FIXED_CLOCK,
      interactionId,
    }),
    reply: textReply([
      '**小吉賭場｜百家樂**',
      '選擇：閒家',
      '閒家：8♠ 10♥｜點數 8',
      '莊家：4♦ J♣｜點數 4',
      '結果：閒家',
      '狀態：命中',
      '下注：10 籌碼',
      '派彩：20 籌碼',
      '本局損益：+10 籌碼',
      '籌碼餘額：210 籌碼',
    ]),
  },
  {
    key: 'poker-straight-flush',
    game: 'casino-poker',
    values: { amount: 10 },
    funds: { coins: 500, chips: 200 },
    play: (guildId, userId, interactionId) => playPoker(guildId, userId, {
      amount: 10,
      rng: rngForTopCards(['AS', 'KS', 'QS', 'JS', '10S', '2C', '5D', '7H', '9C', 'JD']),
      date: FIXED_CLOCK,
      interactionId,
    }),
    reply: textReply([
      '**小吉賭場｜撲克牌**',
      '你的牌：A♠ K♠ Q♠ J♠ 10♠｜同花順',
      '小吉牌：2♣ 5♦ 7♥ 9♣ J♦｜高牌',
      '結果：獲勝',
      '下注：10 籌碼',
      '派彩：20 籌碼',
      '本局損益：+10 籌碼',
      '籌碼餘額：210 籌碼',
    ]),
  },
  {
    key: 'blackjack-open',
    game: 'casino-blackjack',
    values: { amount: 10 },
    funds: { coins: 500, chips: 200 },
    play: (guildId, userId, interactionId) => startBlackjack(guildId, userId, {
      amount: 10,
      deck: deckWithTop(['10S', '7H', '9D', '8C']),
      date: FIXED_CLOCK,
      channelId: 'room',
      interactionId,
    }),
    reply: blackjackReply({
      content: (mention) => `${mention} 開了一局 21 點，下注 10 籌碼。`,
      color: 0xf59e0b,
      description: `操作期限：<t:${Math.floor((FIXED_CLOCK.getTime() + BLACKJACK_TTL_MS) / 1000)}:R>`,
      status: 'active',
      payout: '0 籌碼',
      player: '10♠ 7♥\n點數：17',
      dealer: '9♦ 暗牌\n點數：9+',
      disabled: false,
    }),
  },
  {
    key: 'blackjack-natural-with-top-up',
    game: 'casino-blackjack',
    values: { amount: 10 },
    funds: { coins: 100, chips: 4 },
    play: (guildId, userId, interactionId) => startBlackjack(guildId, userId, {
      amount: 10,
      deck: deckWithTop(['AS', 'KH', '9D', '8C']),
      date: FIXED_CLOCK,
      channelId: 'room',
      interactionId,
    }),
    reply: blackjackReply({
      content: (mention) => `${mention} 的 21 點已結算，本局損益 +15 籌碼。\n籌碼不足，已自動用吉幣兌換 6 籌碼。`,
      color: 0x22c55e,
      description: '自然 21 點。',
      status: 'settled',
      payout: '25 籌碼',
      player: 'A♠ K♥\n點數：21',
      dealer: '9♦ 8♣\n點數：17',
      disabled: true,
    }),
  },
  {
    key: 'duel-win',
    game: 'duel-tower',
    values: { 'weapon-item-id': E2E_WEAPON_ID, wager: 2 },
    funds: { coins: 500, chips: 200 },
    play: (guildId, userId, interactionId) => enterDuelTower(guildId, userId, {
      weaponItemId: E2E_WEAPON_ID, wager: 2, rng: scriptedRng([59, 0]), date: FIXED_CLOCK, interactionId,
    }),
    reply: textReply([
      '**決鬥塔台｜挑戰結算**',
      '層數：第 1 層',
      '對手：塔台見習守衛',
      '武器：合成鐵劍',
      '結果：勝利',
      '本次損益：+2 籌碼',
      '籌碼餘額：202 籌碼',
    ]),
  },
  {
    key: 'duel-loss-with-top-up',
    game: 'duel-tower',
    values: { 'weapon-item-id': E2E_WEAPON_ID, wager: 2 },
    funds: { coins: 100, chips: 1 },
    play: (guildId, userId, interactionId) => enterDuelTower(guildId, userId, {
      weaponItemId: E2E_WEAPON_ID, wager: 2, rng: scriptedRng([0, 79]), date: FIXED_CLOCK, interactionId,
    }),
    reply: textReply([
      '**決鬥塔台｜挑戰結算**',
      '層數：第 1 層',
      '對手：塔台見習守衛',
      '武器：合成鐵劍',
      '結果：落敗',
      '本次損益：-2 籌碼',
      '籌碼餘額：0 籌碼',
      '籌碼不足，已自動用吉幣兌換 1 籌碼。',
    ]),
  },
];

test('賭場六款遊戲與決鬥塔台：固定亂數、牌組與時鐘下，兩條路徑的回覆逐行等於固定的期望值', async () => {
  await ensureDatabase();
  for (const entry of FIXED_LAUNCHES) {
    const guildId = `fixed-${entry.key}`;
    const userId = `fixed-player-${entry.key}`;
    const interactionId = `fixed-launch-${entry.key}`;
    await fundFixedLaunch(guildId, userId, entry.funds);
    // The weapon is a global item the person owns; the person has to exist before it can be put in the inventory.
    await seedBattleWeapon(userId, E2E_WEAPON_ID);
    const played = await entry.play(guildId, userId, interactionId);
    assert.equal(played.alreadyApplied, false, entry.key);
    const afterPlay = await launchState();
    const expected = { replies: [entry.reply(played, userId)], deferred: [], edits: [], followUps: [] };

    for (const via of ['board', 'command']) {
      const { interaction, log } = createBoardInteraction({
        id: interactionId,
        guildId,
        userId,
        values: via === 'board' ? { game: entry.game, ...entry.values } : entry.values,
      });

      if (via === 'board') await boardCommand.execute(interaction);
      else await launchThroughCommandFile(interaction, entry.game);

      assert.deepEqual(receivedFromLaunch(log), expected, `${entry.key} / ${via}`);
    }
    assert.deepEqual(await launchState(), afterPlay, `${entry.key}: the launches replayed the played outcome`);
  }
});

test('從 /board start 進入文字接龍與數字接龍：在指定頻道建立進行中的一局並啟用設定', async () => {
  await ensureDatabase();
  const word = createBoardInteraction({
    id: 'e2e-word-chain', channelId: WORD_CHANNEL_ID, values: { game: 'word-chain', seed: '地球' },
  });
  await boardCommand.execute(word.interaction);
  assert.equal(word.log.replies.length, 1);
  assert.equal(word.log.replies[0].ephemeral, true);
  assert.match(word.log.replies[0].content, /文字接龍開始！起始詞是「地球」/u);

  const number = createBoardInteraction({
    id: 'e2e-number-chain', channelId: NUMBER_CHANNEL_ID, values: { game: 'number-chain', target: 50 },
  });
  await boardCommand.execute(number.interaction);
  assert.equal(number.log.replies.length, 1);
  assert.equal(number.log.replies[0].ephemeral, true);
  assert.match(number.log.replies[0].content, /數字接龍開始！目前要接 50/u);

  const rows = await withCoinDatabase((api) => ({
    word: api.get(`SELECT status, current_word, started_by FROM text_chain_sessions
      WHERE guild_id = 'guild' AND channel_id = ? ORDER BY id DESC LIMIT 1`, [WORD_CHANNEL_ID]),
    wordSetting: api.get("SELECT enabled, channel_id FROM feature_guild_settings WHERE guild_id = 'guild' AND feature_key = 'word_chain'"),
    number: api.get(`SELECT status, expected_target, started_by FROM number_chain_sessions
      WHERE guild_id = 'guild' AND channel_id = ? ORDER BY id DESC LIMIT 1`, [NUMBER_CHANNEL_ID]),
    numberSetting: api.get("SELECT enabled, channel_id FROM feature_guild_settings WHERE guild_id = 'guild' AND feature_key = 'number_chain'"),
  }));
  assert.deepEqual(rows.word, { status: 'active', current_word: '地球', started_by: 'player' });
  assert.deepEqual({ ...rows.wordSetting, enabled: Number(rows.wordSetting.enabled) },
    { enabled: 1, channel_id: WORD_CHANNEL_ID });
  assert.deepEqual({ ...rows.number, expected_target: Number(rows.number.expected_target) },
    { status: 'active', expected_target: 50, started_by: 'player' });
  assert.deepEqual({ ...rows.numberSetting, enabled: Number(rows.numberSetting.enabled) },
    { enabled: 1, channel_id: NUMBER_CHANNEL_ID });
});

test('接龍遊戲的起始字、目標數字與頻道都是選填，未填時用預設值而不被當成缺少選項', async () => {
  await ensureDatabase();
  const word = createBoardInteraction({
    id: 'e2e-word-default', channelId: WORD_DEFAULT_CHANNEL_ID, values: { game: 'word-chain' },
  });
  await boardCommand.execute(word.interaction);
  assert.equal(word.log.replies.length, 1);
  assert.ok(word.log.replies[0].content.includes(`文字接龍開始！起始詞是「${DEFAULT_SEED}」`));

  const number = createBoardInteraction({
    id: 'e2e-number-default', channelId: NUMBER_DEFAULT_CHANNEL_ID, values: { game: 'number-chain' },
  });
  await boardCommand.execute(number.interaction);
  assert.equal(number.log.replies.length, 1);
  assert.ok(number.log.replies[0].content.includes(`數字接龍開始！目前要接 ${DEFAULT_TARGET}`));
});

test('從 /board start 進入個人遊戲：建立工作階段、綁定面板訊息，未填難度時用一般', async () => {
  await ensureDatabase();
  const client = { channels: { fetch: async () => null } };
  configureSoloRuntime(createSoloDiscordRuntime({
    service: createSoloSessionService({ withDatabase: withCoinDatabase, withTransaction: withCoinTransaction }),
    client,
    renderPng: () => Buffer.alloc(16),
  }));

  const easy = createBoardInteraction({
    id: 'e2e-solo-easy', channelId: 'solo-room-easy', client, values: { game: 'sudoku', difficulty: 'easy' },
  });
  await boardCommand.execute(easy.interaction);
  const defaulted = createBoardInteraction({
    id: 'e2e-solo-default', channelId: 'solo-room-default', client, values: { game: 'tetris' },
  });
  await boardCommand.execute(defaulted.interaction);

  assert.deepEqual(easy.log.deferred, [null]);
  assert.equal(easy.log.edits.length, 1);
  assert.match(easy.log.edits[0].content, /^數獨・簡單｜進行中/u);
  assert.match(defaulted.log.edits[0].content, /^俄羅斯方塊・一般｜進行中/u);
  assert.equal(easy.log.replies.length + defaulted.log.replies.length, 0);
  const rows = await withCoinDatabase((api) => ({
    easy: api.get(`SELECT game_type, difficulty, status, message_id FROM discord_game_sessions
      WHERE user_id = 'player' AND channel_id = 'solo-room-easy'`),
    defaulted: api.get(`SELECT game_type, difficulty, status, message_id FROM discord_game_sessions
      WHERE user_id = 'player' AND channel_id = 'solo-room-default'`),
  }));
  assert.deepEqual(rows.easy, { game_type: 'sudoku', difficulty: 'easy', status: 'active', message_id: 'e2e-solo-easy-message' });
  assert.deepEqual(rows.defaulted,
    { game_type: 'tetris', difficulty: 'normal', status: 'active', message_id: 'e2e-solo-default-message' });
  assert.deepEqual(await launchReceipt('e2e-solo-easy'), { kind: 'solo-game', user_id: 'player', guild_id: 'guild' });
});

// A client whose channel holds the panels of personal games. A panel in `missing` is gone (Discord answers 10008).
function createPanelClient() {
  const edits = [];
  const missing = new Set();
  const client = { channels: { fetch: async (channelId) => ({
    id: channelId,
    guildId: 'guild',
    messages: { fetch: async (messageId) => {
      if (missing.has(messageId)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      return { id: messageId, edit: async (payload) => { edits.push({ messageId, payload }); } };
    } },
  }) } };
  return { client, edits, missing };
}

function useSoloRuntime(panels, options = {}) {
  const service = createSoloSessionService({ withDatabase: withCoinDatabase, withTransaction: withCoinTransaction, ...options });
  configureSoloRuntime(createSoloDiscordRuntime({
    service, client: panels.client, renderPng: () => Buffer.alloc(16),
  }));
  return service;
}

async function openSolo(service, { id, userId = 'player', guildId = 'guild', channelId, gameType, difficulty = 'easy' }) {
  const created = await service.create({ userId, guildId, channelId, gameType, difficulty, interactionId: id });
  await service.bindMessage({ sessionId: created.id, actorId: userId, guildId, channelId, messageId: `${id}-message` });
  return created;
}

async function soloStatuses() {
  return withCoinDatabase((api) => Object.fromEntries(
    api.all("SELECT message_id, status FROM discord_game_sessions WHERE message_id LIKE 'stop-%'").map((row) => [row.message_id, row.status]),
  ));
}

test('/board stop 結束呼叫者自己在本頻道的個人遊戲：面板改成已結束、不發獎勵，別人的與別頻道的不受影響', async () => {
  await ensureDatabase();
  const panels = createPanelClient();
  const service = useSoloRuntime(panels);
  const boardCalls = [];
  await useBoardRuntime({ executeCommand: async (interaction) => { boardCalls.push(interaction.id); return null; } });
  await openSolo(service, { id: 'stop-a1', channelId: 'stop-room-a', gameType: 'sudoku' });
  await openSolo(service, { id: 'stop-a2', channelId: 'stop-room-a', gameType: 'tetris' });
  await openSolo(service, { id: 'stop-a3', channelId: 'stop-room-b', gameType: 'sudoku' });
  await openSolo(service, { id: 'stop-a4', userId: 'bystander', channelId: 'stop-room-a', gameType: 'number-match' });

  const first = createBoardInteraction({ id: 'stop-a-run', subcommand: 'stop', channelId: 'stop-room-a' });
  const result = await boardCommand.execute(first.interaction);

  assert.equal(result.ok, true);
  assert.equal(result.ended.length, 2);
  // The answer is private, names the games, and says that no reward is paid.
  assert.deepEqual(first.log.deferred, [{ ephemeral: true }]);
  assert.equal(first.log.replies.length, 0);
  assert.equal(first.log.edits.length, 1);
  assert.match(first.log.edits[0].content, /已結束你在這個頻道的個人遊戲：/u);
  assert.match(first.log.edits[0].content, /數獨/u);
  assert.match(first.log.edits[0].content, /俄羅斯方塊/u);
  assert.match(first.log.edits[0].content, /不發獎勵/u);
  assert.match(first.log.edits[0].content, /已改成「已結束」/u);
  assert.deepEqual(first.log.edits[0].allowedMentions, { parse: [] });
  // Only the caller's two games in this channel ended; the other channel and the other person's game keep running.
  assert.deepEqual(await soloStatuses(), {
    'stop-a1-message': 'cancelled', 'stop-a2-message': 'cancelled',
    'stop-a3-message': 'active', 'stop-a4-message': 'active',
  });
  // The public panels say the game ended and lost their buttons.
  assert.deepEqual(panels.edits.map((edit) => edit.messageId).sort(), ['stop-a1-message', 'stop-a2-message']);
  for (const { payload } of panels.edits) {
    assert.match(payload.content, /｜已提前結束，沒有獎勵｜/u);
    assert.doesNotMatch(payload.content, /進行中|獎勵待確認/u);
    assert.deepEqual(payload.components, []);
  }
  // The board's own stop was not used for these games.
  assert.deepEqual(boardCalls, []);
  // An ended game accepts no more moves, and a fresh lookup no longer finds it.
  const ended = await withCoinDatabase((api) => api.get(
    "SELECT id, revision FROM discord_game_sessions WHERE message_id = 'stop-a1-message'"));
  await assert.rejects(service.apply({ sessionId: ended.id, actorId: 'player', guildId: 'guild', channelId: 'stop-room-a',
    messageId: 'stop-a1-message', expectedRevision: Number(ended.revision), interactionId: 'stop-a1-late',
    action: { type: 'set', row: 0, column: 0, value: 1 } }), { code: 'SESSION_NOT_ACTIVE' });
  assert.equal(await service.findLatest({ actorId: 'player', guildId: 'guild', channelId: 'stop-room-a' }), null);

  // With nothing of the caller's left in this channel the board's own stop answers, as before.
  const again = createBoardInteraction({ id: 'stop-a-again', subcommand: 'stop', channelId: 'stop-room-a' });
  await boardCommand.execute(again.interaction);
  assert.deepEqual(boardCalls, ['stop-a-again']);
  assert.equal(again.log.edits.length + again.log.replies.length + again.log.deferred.length, 0);
  assert.equal((await soloStatuses())['stop-a3-message'], 'active');
});

test('/board stop：個人遊戲已結束，但面板訊息改不動時，照樣結束並說明面板沒能更新', async () => {
  await ensureDatabase();
  const panels = createPanelClient();
  const service = useSoloRuntime(panels);
  await useBoardRuntime();
  await openSolo(service, { id: 'stop-b1', channelId: 'stop-room-c', gameType: 'sudoku' });
  panels.missing.add('stop-b1-message');

  const run = createBoardInteraction({ id: 'stop-b-run', subcommand: 'stop', channelId: 'stop-room-c' });
  const result = await boardCommand.execute(run.interaction);

  assert.equal(result.ok, true);
  assert.match(run.log.edits[0].content, /已結束你在這個頻道的個人遊戲：數獨/u);
  assert.match(run.log.edits[0].content, /1 個遊戲面板沒能更新/u);
  assert.match(run.log.edits[0].content, /遊戲本身已結束/u);
  assert.equal((await soloStatuses())['stop-b1-message'], 'cancelled');
});

test('/board stop：呼叫者是本頻道公開局的房主時由棋盤處理，個人遊戲不動；不是房主時才結束個人遊戲', async () => {
  await ensureDatabase();
  const panels = createPanelClient();
  const service = useSoloRuntime(panels);
  const boardCalls = [];
  let hostId = 'player';
  await useBoardRuntime({
    executeCommand: async (interaction) => { boardCalls.push(interaction.id); return null; },
    service: { status: async () => ({ session: { gameKey: 'gomoku', hostId } }) },
  });
  await openSolo(service, { id: 'stop-c1', channelId: 'stop-room-d', gameType: 'tetris' });

  const asHost = createBoardInteraction({ id: 'stop-c-host', subcommand: 'stop', channelId: 'stop-room-d' });
  await boardCommand.execute(asHost.interaction);
  assert.deepEqual(boardCalls, ['stop-c-host']);
  assert.equal((await soloStatuses())['stop-c1-message'], 'active');
  assert.equal(asHost.log.edits.length + asHost.log.deferred.length, 0);

  hostId = 'someone-else';
  const asGuest = createBoardInteraction({ id: 'stop-c-guest', subcommand: 'stop', channelId: 'stop-room-d' });
  await boardCommand.execute(asGuest.interaction);
  assert.deepEqual(boardCalls, ['stop-c-host']);
  assert.equal((await soloStatuses())['stop-c1-message'], 'cancelled');
  assert.match(asGuest.log.edits[0].content, /已結束你在這個頻道的個人遊戲：俄羅斯方塊/u);
});

test('/board stop：伺服器沒有任何審核紀錄也一樣，非擁有者可以結束自己的個人遊戲，不再交給棋盤', async () => {
  await ensureDatabase();
  const panels = createPanelClient();
  const service = useSoloRuntime(panels);
  const boardCalls = [];
  await useBoardRuntime({ executeCommand: async (interaction) => { boardCalls.push(interaction.id); return null; } });
  await openSolo(service, { id: 'stop-d1', userId: 'visitor', guildId: 'unrecorded-guild', channelId: 'stop-room-e', gameType: 'sudoku' });

  const run = createBoardInteraction({ id: 'stop-d-run', subcommand: 'stop', userId: 'visitor',
    guildId: 'unrecorded-guild', channelId: 'stop-room-e' });
  await boardCommand.execute(run.interaction);

  assert.deepEqual(boardCalls, []);
  assert.equal((await soloStatuses())['stop-d1-message'], 'cancelled');
  assert.match(run.log.edits[0].content, /已結束你在這個頻道的個人遊戲：數獨/u);
});

test('個人遊戲服務的 cancelActive：已逾時的局與別人的局不會被結束，結束後版本加一', async () => {
  await ensureDatabase();
  let now = new Date('2026-10-11T03:00:00.000Z');
  const service = createSoloSessionService({ withDatabase: withCoinDatabase, withTransaction: withCoinTransaction,
    clock: () => now });
  await openSolo(service, { id: 'stop-e1', channelId: 'stop-room-f', gameType: 'sudoku' });
  await openSolo(service, { id: 'stop-e2', userId: 'bystander', channelId: 'stop-room-f', gameType: 'sudoku' });

  // Past the 30 minute lifetime the game has run out of time by itself; it is not turned into an early ending.
  now = new Date('2026-10-11T03:31:00.000Z');
  assert.deepEqual(await service.cancelActive({ actorId: 'player', guildId: 'guild', channelId: 'stop-room-f' }), []);
  assert.equal((await soloStatuses())['stop-e1-message'], 'active');

  now = new Date('2026-10-11T03:10:00.000Z');
  const [ended, ...rest] = await service.cancelActive({ actorId: 'player', guildId: 'guild', channelId: 'stop-room-f' });
  assert.equal(rest.length, 0);
  assert.equal(ended.status, 'cancelled');
  assert.equal(ended.revision, 1);
  assert.equal(ended.userId, 'player');
  assert.equal(ended.state.solution, undefined);
  assert.equal((await soloStatuses())['stop-e2-message'], 'active');
  // Nothing left to end the second time.
  assert.deepEqual(await service.cancelActive({ actorId: 'player', guildId: 'guild', channelId: 'stop-room-f' }), []);
  const reward = await withCoinDatabase((api) => api.get(
    'SELECT COUNT(*) AS count FROM discord_game_rewards WHERE session_id = ?', [ended.id]));
  assert.equal(Number(reward.count), 0);
});

test('從 /board start 進入每日猜謎：只公開開一次，之後私密回報同一個討論串；未啟用時私密說明', async (t) => {
  await ensureDatabase();
  const now = new Date('2026-09-30T03:00:00.000Z'); // 台北 11:00，在開放時段內
  const riddle = createRiddleFixture('e2e-riddle', now);
  await setGuildFeatureSetting(riddle.guildId, 'daily_riddle', { enabled: true, channelId: riddle.parentId, now });

  t.mock.timers.enable({ apis: ['Date'], now });
  const first = createBoardInteraction({
    id: 'e2e-riddle-first', guildId: riddle.guildId, channelId: 'riddle-room', client: riddle.client,
    values: { game: 'daily-riddle' },
  });
  const second = createBoardInteraction({
    id: 'e2e-riddle-second', guildId: riddle.guildId, channelId: 'riddle-room', client: riddle.client,
    values: { game: 'daily-riddle' },
  });
  try {
    await boardCommand.execute(first.interaction);
    await boardCommand.execute(second.interaction);
  } finally {
    t.mock.timers.reset();
  }

  for (const { log } of [first, second]) {
    assert.deepEqual(log.deferred, [{ ephemeral: true }]);
    assert.equal(log.replies.length, 0);
    assert.equal(log.edits.length, 1);
    assert.match(log.edits[0].content, new RegExp(`今天的每日猜謎在 <#${riddle.threadId}>`, 'u'));
  }
  assert.equal(riddle.counters.sends, 1);
  assert.equal(riddle.counters.threads, 1);

  const disabled = createBoardInteraction({
    id: 'e2e-riddle-disabled', guildId: 'e2e-riddle-disabled-guild', client: riddle.client,
    values: { game: 'daily-riddle' },
  });
  await boardCommand.execute(disabled.interaction);
  assert.deepEqual(disabled.log.deferred, [{ ephemeral: true }]);
  assert.match(disabled.log.edits[0].content, /尚未啟用每日猜謎/u);
});

test('從 /board start 進入桌遊：交給桌遊 runtime，不經過賭場、接龍或個人遊戲', async () => {
  const handled = [];
  await useBoardRuntime({ executeCommand: async (interaction) => {
    handled.push(interaction.id);
    return { ok: true, routed: 'board-runtime' };
  } });
  const { interaction, log } = createBoardInteraction({ id: 'e2e-chess', values: { game: 'chess' } });

  const result = await boardCommand.execute(interaction);

  assert.deepEqual(handled, ['e2e-chess']);
  assert.deepEqual(result, { ok: true, routed: 'board-runtime' });
  assert.equal(log.replies.length + log.edits.length + log.deferred.length, 0);
});

test('開局時反應防護無法啟用：管理員收到私密說明，沒有開始新的一局，其他錯誤仍走通用訊息', async () => {
  await ensureDatabase();
  configureChainReactionFence(null);
  try {
    for (const [game, guildId, channelId, values] of [
      ['word-chain', 'fence-word-guild', FENCE_WORD_CHANNEL_ID, { game: 'word-chain', seed: '地球' }],
      ['number-chain', 'fence-number-guild', FENCE_NUMBER_CHANNEL_ID, { game: 'number-chain', target: 50 }],
    ]) {
      const { interaction, log } = createBoardInteraction({ id: `fence-fresh-${game}`, guildId, channelId, values });

      const warnings = await captureWarnings(() => boardCommand.execute(interaction));

      assert.equal(log.replies.length, 1, game);
      assert.equal(log.replies[0].ephemeral, true, game);
      assert.deepEqual(log.replies[0].allowedMentions, { parse: [] }, game);
      assert.match(log.replies[0].content, /反應防護暫時無法啟用.*沒有開始新的一局.*保持停用/u, game);
      assert.match(log.replies[0].content, /若仍失敗，請聯絡機器人擁有者/u, game);
      assert.doesNotMatch(log.replies[0].content, /原頻道/u, game);
      assert.doesNotMatch(log.replies[0].content, INTERNAL_DETAIL, game);
      assert.deepEqual(warnings, [`/board ${game} failed: REACTION_FENCE_OPEN_FAILED`], game);
      const table = game === 'word-chain' ? 'text_chain_sessions' : 'number_chain_sessions';
      const featureKey = game === 'word-chain' ? 'word_chain' : 'number_chain';
      const state = await withCoinDatabase((api) => ({
        rounds: api.all(`SELECT channel_id, status FROM ${table} WHERE guild_id = ?`, [guildId]),
        setting: api.get('SELECT enabled, channel_id FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?',
          [guildId, featureKey]),
      }));
      assert.deepEqual(state.rounds, [{ channel_id: channelId, status: 'stopped' }], game);
      assert.deepEqual({ enabled: Number(state.setting.enabled), channel_id: state.setting.channel_id },
        { enabled: 0, channel_id: null }, game);
    }
  } finally {
    configureChainReactionFence(syntheticReactionRuntime);
  }

  // An error nobody mapped keeps the generic wording instead of leaking its own text.
  await withCoinTransaction((api) => api.run(
    `INSERT INTO feature_guild_settings (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at)
     VALUES ('broken-config-guild', 'word_chain', 0, NULL, '{broken', ?, ?)`,
    [new Date().toISOString(), new Date().toISOString()],
  ));
  const broken = createBoardInteraction({
    id: 'fence-unmapped', guildId: 'broken-config-guild', channelId: BROKEN_CONFIG_CHANNEL_ID,
    values: { game: 'word-chain', seed: '地球' },
  });
  await boardCommand.execute(broken.interaction);
  assert.equal(broken.log.replies.length, 1);
  assert.equal(broken.log.replies[0].content, '文字接龍設定失敗，請稍後再試。');
  assert.equal(broken.log.replies[0].ephemeral, true);
});

test('進行中的接龍在同頻道重新開局而反應防護無法啟用：說明設定已暫停、進度保留，三種狀態查詢都顯示已暫停，恢復後接續同一局', async () => {
  await ensureDatabase();
  for (const [game, command, guildId, channelId, values, table, featureKey, resumed] of [
    ['word-chain', wordChainCommand, 'pause-word-guild', PAUSE_WORD_CHANNEL_ID, { game: 'word-chain', seed: '地球' },
      'text_chain_sessions', 'word_chain', '這個頻道的文字接龍已在進行中，目前詞為「地球」。'],
    ['number-chain', numberChainCommand, 'pause-number-guild', PAUSE_NUMBER_CHANNEL_ID, { game: 'number-chain', target: 50 },
      'number_chain_sessions', 'number_chain', '這個頻道的數字接龍已在進行中，目前要接 50。'],
  ]) {
    const roundState = () => withCoinDatabase((api) => {
      const setting = api.get(
        'SELECT enabled, channel_id, config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?',
        [guildId, featureKey]);
      return {
        rounds: api.all(`SELECT id, status, revision FROM ${table} WHERE guild_id = ? ORDER BY id`, [guildId]),
        setting: { enabled: Number(setting.enabled), channel_id: setting.channel_id },
        authority: JSON.parse(setting.config_json)._chainReaction,
      };
    });
    // The status of the round through the three places a person can ask: the game's own command, /board status
    // with the game, and the /board status catalog.
    const statusTexts = async (label) => {
      const direct = createBoardInteraction({ id: `${label}-direct`, subcommand: 'status', guildId, channelId });
      await command.execute(direct.interaction);
      const unified = createBoardInteraction({
        id: `${label}-unified`, subcommand: 'status', guildId, channelId, values: { game },
      });
      await boardCommand.execute(unified.interaction);
      const catalog = createBoardInteraction({ id: `${label}-catalog`, subcommand: 'status', guildId, channelId });
      await boardCommand.execute(catalog.interaction);
      for (const { log } of [direct, unified]) {
        assert.equal(log.replies.length, 1, `${game} ${label}`);
        assert.equal(log.replies[0].ephemeral, true, `${game} ${label}`);
        assert.deepEqual(log.replies[0].allowedMentions, { parse: [] }, `${game} ${label}`);
      }
      assert.equal(catalog.log.edits.length, 1, `${game} ${label}`);
      return [direct.log.replies[0].content, unified.log.replies[0].content, catalog.log.edits[0].content];
    };

    const first = createBoardInteraction({ id: `pause-first-${game}`, guildId, channelId, values });
    await boardCommand.execute(first.interaction);
    const started = await roundState();
    assert.equal(started.rounds.length, 1, game);
    assert.equal(started.rounds[0].status, 'active', game);
    assert.deepEqual(started.setting, { enabled: 1, channel_id: channelId }, game);
    assert.equal(started.authority.revoked, false, game);
    for (const text of await statusTexts('running')) {
      assert.match(text, /進行中|目前頻道公開局/u, `${game} running`);
      assert.doesNotMatch(text, /已暫停/u, `${game} running`);
    }

    configureChainReactionFence(null);
    const paused = createBoardInteraction({ id: `pause-second-${game}`, guildId, channelId, values });
    try {
      await captureWarnings(() => boardCommand.execute(paused.interaction));
    } finally {
      configureChainReactionFence(syntheticReactionRuntime);
    }
    assert.equal(paused.log.replies.length, 1, game);
    assert.equal(paused.log.replies[0].ephemeral, true, game);
    assert.deepEqual(paused.log.replies[0].allowedMentions, { parse: [] }, game);
    assert.match(paused.log.replies[0].content, /反應防護暫時無法啟用.*設定已暫停.*進度已保留/u, game);
    assert.match(paused.log.replies[0].content, /若仍失敗，請聯絡機器人擁有者/u, game);
    assert.doesNotMatch(paused.log.replies[0].content, INTERNAL_DETAIL, game);
    const afterPause = await roundState();
    assert.deepEqual(afterPause.rounds, started.rounds, game);
    assert.deepEqual(afterPause.setting, { enabled: 0, channel_id: null }, game);
    assert.deepEqual(afterPause.authority, started.authority, `${game} keeps the reaction authority`);
    const pausedTexts = await statusTexts('paused');
    for (const text of pausedTexts) {
      assert.match(text, /已暫停/u, `${game} paused`);
      assert.doesNotMatch(text, /進行中/u, `${game} paused`);
    }
    assert.match(pausedTexts[0], /進度已保留.*\/board start/u, game);
    assert.match(pausedTexts[1], /進度已保留.*\/board start/u, game);

    const resume = createBoardInteraction({ id: `pause-third-${game}`, guildId, channelId, values });
    await boardCommand.execute(resume.interaction);
    assert.equal(resume.log.replies[0].content, resumed, game);
    const afterResume = await roundState();
    assert.deepEqual(afterResume.rounds, started.rounds, game);
    assert.deepEqual(afterResume.setting, { enabled: 1, channel_id: channelId }, game);
    assert.deepEqual(afterResume.authority, started.authority, game);
    for (const text of await statusTexts('resumed')) {
      assert.match(text, /進行中|目前頻道公開局/u, `${game} resumed`);
      assert.doesNotMatch(text, /已暫停/u, `${game} resumed`);
    }
  }
});

test('換頻道開局而反應防護無法啟用：說明原頻道的那一局已結束，兩個頻道都不再有進行中的局', async () => {
  await ensureDatabase();
  for (const [game, guildId, oldChannelId, newChannelId, values, table, featureKey] of [
    ['word-chain', 'switch-word-guild', SWITCH_WORD_OLD_CHANNEL_ID, SWITCH_WORD_NEW_CHANNEL_ID,
      { game: 'word-chain', seed: '地球' }, 'text_chain_sessions', 'word_chain'],
    ['number-chain', 'switch-number-guild', SWITCH_NUMBER_OLD_CHANNEL_ID, SWITCH_NUMBER_NEW_CHANNEL_ID,
      { game: 'number-chain', target: 50 }, 'number_chain_sessions', 'number_chain'],
  ]) {
    const first = createBoardInteraction({ id: `switch-first-${game}`, guildId, channelId: oldChannelId, values });
    await boardCommand.execute(first.interaction);

    configureChainReactionFence(null);
    const switched = createBoardInteraction({ id: `switch-second-${game}`, guildId, channelId: newChannelId, values });
    try {
      await captureWarnings(() => boardCommand.execute(switched.interaction));
    } finally {
      configureChainReactionFence(syntheticReactionRuntime);
    }

    assert.equal(switched.log.replies.length, 1, game);
    assert.equal(switched.log.replies[0].ephemeral, true, game);
    assert.deepEqual(switched.log.replies[0].allowedMentions, { parse: [] }, game);
    assert.match(switched.log.replies[0].content, /沒有開始新的一局.*原頻道的那一局已結束/u, game);
    assert.match(switched.log.replies[0].content, /若仍失敗，請聯絡機器人擁有者/u, game);
    assert.doesNotMatch(switched.log.replies[0].content, INTERNAL_DETAIL, game);
    const state = await withCoinDatabase((api) => ({
      rounds: api.all(`SELECT channel_id, status FROM ${table} WHERE guild_id = ? ORDER BY id`, [guildId]),
      setting: api.get('SELECT enabled, channel_id FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?',
        [guildId, featureKey]),
    }));
    assert.deepEqual(state.rounds, [
      { channel_id: oldChannelId, status: 'stopped' },
      { channel_id: newChannelId, status: 'stopped' },
    ], game);
    assert.deepEqual({ enabled: Number(state.setting.enabled), channel_id: state.setting.channel_id },
      { enabled: 0, channel_id: null }, game);
  }
});

test('詞庫版本無法辨識的文字接龍：開局與兩種狀態查詢都私密說明，停止後可重新開局', async () => {
  await ensureDatabase();
  const guildId = 'corpus-guild';
  const first = createBoardInteraction({
    id: 'corpus-first', guildId, channelId: CORPUS_CHANNEL_ID, values: { game: 'word-chain', seed: '空氣' },
  });
  await boardCommand.execute(first.interaction);
  assert.match(first.log.replies[0].content, /文字接龍開始！/u);
  await withCoinTransaction((api) => api.run(
    "UPDATE text_chain_sessions SET corpus_version = 'unrecognized' WHERE guild_id = ?", [guildId],
  ));

  for (const [label, command, spec] of [
    ['/board start', boardCommand, { id: 'corpus-restart', values: { game: 'word-chain' } }],
    ['/word-chain status', wordChainCommand, { id: 'corpus-command-status', subcommand: 'status' }],
    ['/board status', boardCommand, { id: 'corpus-board-status', subcommand: 'status', values: { game: 'word-chain' } }],
  ]) {
    const { interaction, log } = createBoardInteraction({ guildId, channelId: CORPUS_CHANNEL_ID, ...spec });

    await captureWarnings(() => command.execute(interaction));

    assert.equal(log.replies.length, 1, label);
    assert.equal(log.replies[0].ephemeral, true, label);
    assert.deepEqual(log.replies[0].allowedMentions, { parse: [] }, label);
    assert.match(log.replies[0].content, /詞庫版本無法辨識.*\/word-chain stop/u, label);
    assert.doesNotMatch(log.replies[0].content, INTERNAL_DETAIL, label);
  }

  const stop = createBoardInteraction({
    id: 'corpus-stop', subcommand: 'stop', guildId, channelId: CORPUS_CHANNEL_ID,
  });
  await wordChainCommand.execute(stop.interaction);
  assert.equal(stop.log.replies[0].content, '這個頻道的文字接龍已停止。');
  const again = createBoardInteraction({
    id: 'corpus-again', guildId, channelId: CORPUS_CHANNEL_ID, values: { game: 'word-chain', seed: '地球' },
  });
  await boardCommand.execute(again.interaction);
  assert.match(again.log.replies[0].content, /文字接龍開始！起始詞是「地球」/u);
});

// Chain games start through /board start, which calls the chain command's execute with a 'start' action. The command's
// checks run before its start branch, each with its own refusal text, in this order: inside a guild,
// a text channel the bot can send to, Manage Server (or Administrator, or the bot owner) for the person, then four
// channel permissions for the bot. The tests below pin that order, the texts, the warnings and the rows a launch
// leaves behind, for /board start and for the chain command's own execute with the same action.
const CHAIN_GAMES = [
  {
    key: 'word-chain',
    command: wordChainCommand,
    label: '文字接龍',
    values: { seed: '地球' },
    rounds: 'wordRounds',
    featureKey: 'word_chain',
    round: (channelId, startedBy) => ({ channel_id: channelId, status: 'active', current_word: '地球', started_by: startedBy }),
    started: '文字接龍開始！起始詞是「地球」，請從「球」字接詞。',
    alreadyActive: '這個頻道的文字接龍已在進行中，目前詞為「地球」。',
    conflict: '這個頻道已有進行中的數字接龍，請先停止它再開始文字接龍。',
    status: /目前詞為「地球」/u,
  },
  {
    key: 'number-chain',
    command: numberChainCommand,
    label: '數字接龍',
    values: { target: 50 },
    rounds: 'numberRounds',
    featureKey: 'number_chain',
    round: (channelId, startedBy) => ({ channel_id: channelId, status: 'active', expected_target: 50, started_by: startedBy }),
    started: '數字接龍開始！目前要接 50；可輸入整數或等值算式，例如 3*5。玩家需輪流作答。',
    alreadyActive: '這個頻道的數字接龍已在進行中，目前要接 50。',
    conflict: '這個頻道已有進行中的文字接龍，請先停止它再開始數字接龍。',
    status: /目前要接 50/u,
  },
];
const MEMBER_PERMISSIONS = Object.freeze({
  none: { has: () => false },
  manageServer: { has: (flag) => flag === PermissionFlagsBits.ManageGuild },
  administrator: { has: (flag) => flag === PermissionFlagsBits.Administrator },
});
const BOT_PERMISSIONS = Object.freeze({
  none: { has: () => false },
  withoutAddReactions: { has: (flag) => flag !== PermissionFlagsBits.AddReactions },
});
// The reaction fence only accepts a channel id that looks like a Discord snowflake.
const CHAIN_CHANNEL_ID = '73000000000000001';
const BOT_PERMISSION_REFUSAL = '小吉需要 View Channel, Send Messages, Add Reactions, Read Message History 權限才能執行 /board。';
const NO_CHAIN_ROWS = Object.freeze({ wordRounds: [], numberRounds: [], settings: [] });
let chainInteractionCount = 0;

// A /board interaction (or, with the command name changed, the chain command's own) whose person and bot
// permissions, channel and guild can be set up per case. Without overrides every permission check passes.
function chainInteraction({ guildId, channelId, userId = 'player', subcommand = 'start', values = {},
  commandName = 'board', member = null, bot = null, unsendable = false, outsideGuild = false,
  guildMissing = false, notInGuild = false, sendMissing = false, channelMissing = false }) {
  chainInteractionCount += 1;
  const created = createBoardInteraction({
    id: `chain-interaction-${chainInteractionCount}`, subcommand, values, userId, guildId, channelId,
  });
  const { interaction } = created;
  interaction.commandName = commandName;
  if (member) interaction.memberPermissions = member;
  if (bot) interaction.channel.permissionsFor = () => bot;
  if (unsendable) interaction.channel.isTextBased = () => false;
  if (outsideGuild) interaction.guildId = null;
  if (guildMissing) interaction.guild = null;
  if (notInGuild) interaction.inGuild = () => false;
  if (sendMissing) interaction.channel.send = undefined;
  if (channelMissing) interaction.channel = null;
  return created;
}

function chainReply(content) {
  return { replies: [{ content, ephemeral: true }], deferred: [], edits: [], followUps: [] };
}

async function chainRows(guildId) {
  return withCoinDatabase((api) => ({
    wordRounds: api.all(`SELECT channel_id, status, current_word, started_by FROM text_chain_sessions
      WHERE guild_id = ? ORDER BY id`, [guildId]),
    numberRounds: api.all(`SELECT channel_id, status, expected_target, started_by FROM number_chain_sessions
      WHERE guild_id = ? ORDER BY id`, [guildId]).map((row) => ({ ...row, expected_target: Number(row.expected_target) })),
    settings: api.all(`SELECT feature_key, enabled, channel_id, config_json FROM feature_guild_settings
      WHERE guild_id = ? ORDER BY feature_key`, [guildId]).map((row) => ({
      feature_key: row.feature_key,
      enabled: Number(row.enabled),
      channel_id: row.channel_id,
      reactionAuthority: Boolean(JSON.parse(row.config_json)._chainReaction),
    })),
  }));
}

function chainSetting(game, channelId) {
  return { feature_key: game.featureKey, enabled: 1, channel_id: channelId, reactionAuthority: true };
}

function expectedChainRun(outcome, game, other, userId) {
  const startedBy = (owner, by) => ({ ...NO_CHAIN_ROWS, [owner.rounds]: [owner.round(CHAIN_CHANNEL_ID, by)],
    settings: [chainSetting(owner, CHAIN_CHANNEL_ID)] });
  switch (outcome) {
    case 'started':
      return { log: chainReply(game.started), rows: startedBy(game, userId), warnings: [] };
    case 'already-active':
      return { log: chainReply(game.alreadyActive), rows: startedBy(game, 'player'), warnings: [] };
    case 'conflict':
      return { log: chainReply(game.conflict), rows: startedBy(other, 'player'), warnings: [] };
    case 'member-refused':
      return {
        log: chainReply('你需要 Manage Server 權限才能使用 /board。'),
        rows: NO_CHAIN_ROWS,
        warnings: ['[PERMISSION_BLOCK] User denied access to /board'],
      };
    case 'bot-refused':
      return { log: chainReply(BOT_PERMISSION_REFUSAL), rows: NO_CHAIN_ROWS, warnings: [] };
    case 'channel-refused':
      return { log: chainReply('請選擇小吉可以傳送訊息的伺服器文字頻道。'), rows: NO_CHAIN_ROWS, warnings: [] };
    case 'guild-refused':
      return { log: chainReply(`${game.label}只能在伺服器內管理。`), rows: NO_CHAIN_ROWS, warnings: [] };
    default:
      throw new Error(`Unknown chain launch outcome: ${outcome}`);
  }
}

const CHAIN_LAUNCH_SCENARIOS = [
  { name: '機器人擁有者開局', userId: 'player', outcome: 'started' },
  { name: '有 Manage Server 的成員開局', userId: 'server-admin', member: 'manageServer', outcome: 'started' },
  { name: '有 Administrator 的成員開局', userId: 'full-admin', member: 'administrator', outcome: 'started' },
  { name: '沒有 Manage Server 的成員被拒絕', userId: 'plain-member', member: 'none', outcome: 'member-refused' },
  { name: '小吉在頻道沒有權限被拒絕', userId: 'server-admin', member: 'manageServer', bot: 'none', outcome: 'bot-refused' },
  { name: '小吉只缺 Add Reactions 也被拒絕', userId: 'server-admin', member: 'manageServer', bot: 'withoutAddReactions',
    outcome: 'bot-refused' },
  { name: '先檢查成員、再檢查小吉的權限', userId: 'plain-member', member: 'none', bot: 'none', outcome: 'member-refused' },
  { name: '先檢查頻道、再檢查成員的權限', userId: 'plain-member', member: 'none', unsendable: true, outcome: 'channel-refused' },
  { name: '有 guildId 但互動沒有 guild 物件', userId: 'player', guildMissing: true, outcome: 'guild-refused' },
  { name: '頻道的 send 不是函式，先於成員的權限被擋下', userId: 'plain-member', member: 'none', sendMissing: true,
    outcome: 'channel-refused' },
  { name: '互動沒有頻道，先於成員的權限被擋下', userId: 'plain-member', member: 'none', channelMissing: true,
    outcome: 'channel-refused' },
  { name: '同頻道已有同一種接龍在進行', userId: 'server-admin', member: 'manageServer', before: 'same', outcome: 'already-active' },
  { name: '同頻道已有另一種接龍在進行', userId: 'server-admin', member: 'manageServer', before: 'other', outcome: 'conflict' },
];

test('接龍開局：/board start 與指令本身的 start 動作走同一組檢查，回覆、警告與留下的資料一致', async () => {
  await ensureDatabase();
  for (const [index, scenario] of CHAIN_LAUNCH_SCENARIOS.entries()) {
    for (const game of CHAIN_GAMES) {
      const other = CHAIN_GAMES.find((candidate) => candidate !== game);
      const runs = {};
      for (const via of ['board', 'command']) {
        const label = `${scenario.name} / ${game.key} / ${via}`;
        const guildId = `chain-launch-${index}-${game.key}-${via}`;
        if (scenario.before) {
          const earlier = scenario.before === 'same' ? game : other;
          await boardCommand.execute(chainInteraction({
            guildId, channelId: CHAIN_CHANNEL_ID, values: { game: earlier.key, ...earlier.values },
          }).interaction);
        }
        const ledgerBefore = await launchState();
        const { interaction, log } = chainInteraction({
          guildId,
          channelId: CHAIN_CHANNEL_ID,
          userId: scenario.userId,
          member: MEMBER_PERMISSIONS[scenario.member],
          bot: BOT_PERMISSIONS[scenario.bot],
          unsendable: scenario.unsendable === true,
          guildMissing: scenario.guildMissing === true,
          sendMissing: scenario.sendMissing === true,
          channelMissing: scenario.channelMissing === true,
          values: via === 'board' ? { game: game.key, ...game.values } : game.values,
        });

        const warnings = await captureWarnings(() => (via === 'board' ? boardCommand : game.command).execute(interaction));

        runs[via] = { log, rows: await chainRows(guildId), warnings };
        assert.deepEqual(runs[via], expectedChainRun(scenario.outcome, game, other, scenario.userId), label);
        assert.deepEqual(await launchState(), ledgerBefore, label);
      }
      assert.deepEqual(runs.command, runs.board, `${scenario.name} / ${game.key}`);
    }
  }
});

test('接龍開局：審核紀錄是待審、未知或已拒絕的伺服器，Manage Server 成員照常開局，紀錄檔不被改動', async () => {
  await ensureDatabase();
  const recordedGuild = (recorded, game, via) => `chain-${recorded}-${game.key}-${via}`;
  const records = {};
  for (const game of CHAIN_GAMES) {
    for (const recorded of ['pending', 'unknown', 'denied']) {
      for (const via of ['board', 'command']) {
        const guildId = recordedGuild(recorded, game, via);
        records[guildId] = { guildId, status: recorded, ...(recorded === 'unknown' ? { manualAudit: true } : {}) };
      }
    }
  }
  const auditText = `${JSON.stringify(records, null, 2)}\n`;
  fs.writeFileSync(process.env.XIAOJI_AUDIT_DATA_PATH, auditText);
  for (const game of CHAIN_GAMES) {
    const other = CHAIN_GAMES.find((candidate) => candidate !== game);
    for (const recorded of ['pending', 'unknown', 'denied']) {
      for (const via of ['board', 'command']) {
        const label = `${game.key} / ${recorded} / ${via}`;
        const guildId = recordedGuild(recorded, game, via);
        const { interaction, log } = chainInteraction({
          guildId,
          channelId: CHAIN_CHANNEL_ID,
          userId: 'server-admin',
          member: MEMBER_PERMISSIONS.manageServer,
          values: via === 'board' ? { game: game.key, ...game.values } : game.values,
        });

        const warnings = await captureWarnings(() => (via === 'board' ? boardCommand : game.command).execute(interaction));

        assert.deepEqual({ log, rows: await chainRows(guildId), warnings },
          expectedChainRun('started', game, other, 'server-admin'), label);
      }
    }
  }
  assert.equal(fs.readFileSync(process.env.XIAOJI_AUDIT_DATA_PATH, 'utf8'), auditText);
});

test('接龍開局：起始字不合法與沒有對應說明的錯誤，仍是原本的文字且不開始新的一局', async () => {
  await ensureDatabase();
  const word = CHAIN_GAMES[0];
  for (const via of ['board', 'command']) {
    for (const [seed, message] of [['a', '請輸入 2 到 6 個中文字。'], ['abc123', '文字接龍只接受純中文詞彙喔。']]) {
      const guildId = `chain-seed-${via}-${seed}`;
      const { interaction, log } = chainInteraction({
        guildId, channelId: CHAIN_CHANNEL_ID, values: via === 'board' ? { game: word.key, seed } : { seed },
      });

      await (via === 'board' ? boardCommand : word.command).execute(interaction);

      assert.deepEqual(log, chainReply(message), `${via} ${seed}`);
      assert.deepEqual(await chainRows(guildId), NO_CHAIN_ROWS, `${via} ${seed}`);
    }
  }

  // A settings row nobody can read is an error that has no explanation of its own: the generic wording stays.
  const timestamp = new Date().toISOString();
  for (const game of CHAIN_GAMES) {
    for (const via of ['board', 'command']) {
      const label = `${game.key} / ${via}`;
      const guildId = `chain-unmapped-${game.key}-${via}`;
      await withCoinTransaction((api) => api.run(
        `INSERT INTO feature_guild_settings (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at)
         VALUES (?, ?, 0, NULL, '{broken', ?, ?)`,
        [guildId, game.featureKey, timestamp, timestamp],
      ));
      const { interaction, log } = chainInteraction({
        guildId, channelId: CHAIN_CHANNEL_ID, values: via === 'board' ? { game: game.key, ...game.values } : game.values,
      });

      const warnings = await captureWarnings(() => (via === 'board' ? boardCommand : game.command).execute(interaction));

      assert.deepEqual(log, chainReply(`${game.label}設定失敗，請稍後再試。`), label);
      assert.deepEqual(warnings, ['/board failed: unknown CHAIN_REACTION_CONFIG_INVALID'], label);
      const rounds = await withCoinDatabase((api) => ({
        word: Number(api.get('SELECT COUNT(*) AS count FROM text_chain_sessions WHERE guild_id = ?', [guildId]).count),
        number: Number(api.get('SELECT COUNT(*) AS count FROM number_chain_sessions WHERE guild_id = ?', [guildId]).count),
      }));
      assert.deepEqual(rounds, { word: 0, number: 0 }, label);
    }
  }
});

test('/word-chain 與 /number-chain 的 stop 與 status：前置檢查的順序、拒絕文字與結果文字', async () => {
  await ensureDatabase();
  for (const game of CHAIN_GAMES) {
    const approvedGuild = `chain-manage-${game.key}`;
    const otherGuild = `chain-manage-other-${game.key}`;
    // The chain command's own stop and status, as a Manage Server member would send them unless the case says otherwise.
    const run = async (subcommand, spec = {}) => {
      const { interaction, log } = chainInteraction({
        guildId: approvedGuild,
        channelId: CHAIN_CHANNEL_ID,
        userId: 'server-admin',
        member: MEMBER_PERMISSIONS.manageServer,
        subcommand,
        commandName: game.key,
        ...spec,
      });
      const warnings = await captureWarnings(() => game.command.execute(interaction));
      return { log, warnings };
    };
    const refused = (content, warnings = []) => ({ log: chainReply(content), warnings });
    const memberRefusal = `你需要 Manage Server 權限才能使用 /${game.key}。`;
    const memberWarning = [`[PERMISSION_BLOCK] User denied access to /${game.key}`];
    const botRefusal = `小吉需要 View Channel, Send Messages, Add Reactions, Read Message History 權限才能執行 /${game.key}。`;
    const noRound = `這個頻道目前沒有進行中的${game.label}。`;

    for (const subcommand of ['status', 'stop']) {
      const label = `${game.key} ${subcommand}`;
      assert.deepEqual(await run(subcommand, { userId: 'plain-member', member: MEMBER_PERMISSIONS.none }),
        refused(memberRefusal, memberWarning), `${label}: member without Manage Server`);
      assert.deepEqual(await run(subcommand, { bot: BOT_PERMISSIONS.none }), refused(botRefusal), `${label}: bot`);
      assert.deepEqual(await run(subcommand, { unsendable: true }),
        refused('請選擇小吉可以傳送訊息的伺服器文字頻道。'), `${label}: channel`);
      assert.deepEqual(await run(subcommand, { outsideGuild: true }),
        refused(`${game.label}只能在伺服器內管理。`), `${label}: outside a guild`);
      // The first check is three tests joined by "or": a guild id, a guild object, and the interaction saying it is in one.
      assert.deepEqual(await run(subcommand, { guildMissing: true }),
        refused(`${game.label}只能在伺服器內管理。`), `${label}: a guild id but no guild object`);
      assert.deepEqual(await run(subcommand, { notInGuild: true }),
        refused(`${game.label}只能在伺服器內管理。`), `${label}: the interaction is not in a guild`);
      // The channel check is two tests: a text channel, and one the bot can send to.
      assert.deepEqual(await run(subcommand, { sendMissing: true }),
        refused('請選擇小吉可以傳送訊息的伺服器文字頻道。'), `${label}: a channel whose send is not a function`);
      assert.deepEqual(await run(subcommand, { channelMissing: true }),
        refused('請選擇小吉可以傳送訊息的伺服器文字頻道。'), `${label}: no channel at all`);
      // A guild with no record of any kind is served like every other guild.
      assert.deepEqual(await run(subcommand, { guildId: otherGuild }), refused(noRound), `${label}: another guild`);
      assert.deepEqual(await run(subcommand, { guildId: otherGuild, unsendable: true }),
        refused('請選擇小吉可以傳送訊息的伺服器文字頻道。'), `${label}: another guild, the channel`);
      assert.deepEqual(await run(subcommand, { member: MEMBER_PERMISSIONS.none, userId: 'player' }),
        refused(noRound), `${label}: the bot owner needs no permission`);
    }
    assert.deepEqual(await run('status'), refused(noRound), `${game.key}: status without a round`);
    assert.deepEqual(await run('stop'), refused(noRound), `${game.key}: stop without a round`);

    const started = chainInteraction({
      guildId: approvedGuild,
      channelId: CHAIN_CHANNEL_ID,
      userId: 'server-admin',
      member: MEMBER_PERMISSIONS.manageServer,
      values: { game: game.key, ...game.values },
    });
    await boardCommand.execute(started.interaction);
    assert.deepEqual(started.log, chainReply(game.started), `${game.key}: started`);
    const status = await run('status');
    assert.equal(status.log.replies.length, 1, game.key);
    assert.equal(status.log.replies[0].ephemeral, true, game.key);
    assert.deepEqual(status.log.replies[0].allowedMentions, { parse: [] }, game.key);
    assert.match(status.log.replies[0].content, game.status, game.key);
    assert.deepEqual(status.warnings, [], game.key);
    assert.deepEqual(await run('stop', { userId: 'full-admin', member: MEMBER_PERMISSIONS.administrator }),
      refused(`這個頻道的${game.label}已停止。`), `${game.key}: an Administrator member stops the round`);
    assert.deepEqual(await run('status'), refused(noRound), `${game.key}: status after the stop`);
  }
});

// The launchers /board start uses for chain games only start a round: they run the same checks as the commands, but
// they never read which subcommand the interaction carries, so a stop or status interaction handed to one still starts.
test('接龍啟動函式只負責開局：不看互動的子指令名稱，開局前仍走同一組檢查', async () => {
  await ensureDatabase();
  for (const [game, launch] of [[CHAIN_GAMES[0], launchWordChain], [CHAIN_GAMES[1], launchNumberChain]]) {
    for (const subcommand of ['start', 'status', 'stop']) {
      const label = `${game.key} ${subcommand}`;
      const guildId = `chain-launcher-${game.key}-${subcommand}`;
      const refused = chainInteraction({
        guildId, channelId: CHAIN_CHANNEL_ID, userId: 'plain-member', member: MEMBER_PERMISSIONS.none,
        subcommand, values: game.values,
      });

      const warnings = await captureWarnings(() => launch(refused.interaction));

      assert.deepEqual(refused.log, chainReply('你需要 Manage Server 權限才能使用 /board。'), label);
      assert.deepEqual(warnings, ['[PERMISSION_BLOCK] User denied access to /board'], label);
      assert.deepEqual(await chainRows(guildId), NO_CHAIN_ROWS, label);

      const started = chainInteraction({
        guildId, channelId: CHAIN_CHANNEL_ID, userId: 'server-admin', member: MEMBER_PERMISSIONS.manageServer,
        subcommand, values: game.values,
      });
      await launch(started.interaction);

      assert.deepEqual(started.log, chainReply(game.started), label);
      assert.deepEqual(await chainRows(guildId), {
        ...NO_CHAIN_ROWS,
        [game.rounds]: [game.round(CHAIN_CHANNEL_ID, 'server-admin')],
        settings: [chainSetting(game, CHAIN_CHANNEL_ID)],
      }, label);
    }
  }
});

// The start function of each chain is exported for the commands, but it does not check anyone's permission itself. It
// starts a round only for the access object that ensure...Access granted for the same interaction, so reaching the
// start without the checks having passed is refused.
test('接龍的開局函式只認 ensure*Access 對同一個互動發出的 access：其餘一律被拒，且什麼都不會開始', async () => {
  await ensureDatabase();
  const emptyLog = { replies: [], deferred: [], edits: [], followUps: [] };
  const chains = [
    { game: CHAIN_GAMES[0], start: startWordChainInChannel, ensure: ensureWordChainAccess, otherEnsure: ensureNumberChainAccess },
    { game: CHAIN_GAMES[1], start: startNumberChainInChannel, ensure: ensureNumberChainAccess, otherEnsure: ensureWordChainAccess },
  ];
  for (const { game, start, ensure, otherEnsure } of chains) {
    const guildId = `chain-access-${game.key}`;
    const admin = { guildId, channelId: CHAIN_CHANNEL_ID, userId: 'server-admin', member: MEMBER_PERMISSIONS.manageServer,
      values: game.values };
    const subject = chainInteraction(admin);
    let refusedAccess;
    await captureWarnings(async () => {
      refusedAccess = await ensure(chainInteraction({
        ...admin, userId: 'plain-member', member: MEMBER_PERMISSIONS.none,
      }).interaction);
    });
    const candidates = [
      ['no access at all', undefined],
      ['the access of a refused check', refusedAccess],
      ['an object that only says ok: true', { ok: true, channel: subject.interaction.channel }],
      ['an access granted for another interaction', await ensure(chainInteraction(admin).interaction)],
      ['an access granted by the other chain', await otherEnsure(subject.interaction)],
    ];
    assert.deepEqual(refusedAccess, { ok: false }, game.key);
    assert.equal(candidates[3][1].ok, true, game.key);
    assert.equal(candidates[4][1].ok, true, game.key);

    for (const [what, access] of candidates) {
      await assert.rejects(() => start(subject.interaction, access), { code: 'CHAIN_ACCESS_REQUIRED' }, `${game.key}: ${what}`);
      assert.deepEqual(subject.log, emptyLog, `${game.key}: ${what}`);
      assert.deepEqual(await chainRows(guildId), NO_CHAIN_ROWS, `${game.key}: ${what}`);
    }

    const granted = await ensure(subject.interaction);
    assert.equal(granted.ok, true, game.key);
    assert.equal(Object.isFrozen(granted), true, game.key);
    await start(subject.interaction, granted);
    assert.deepEqual(subject.log, chainReply(game.started), game.key);
    assert.deepEqual(await chainRows(guildId), {
      ...NO_CHAIN_ROWS,
      [game.rounds]: [game.round(CHAIN_CHANNEL_ID, 'server-admin')],
      settings: [chainSetting(game, CHAIN_CHANNEL_ID)],
    }, game.key);
  }
});

// The real board runtime on an in-memory store, so /board start and /board status run the code that answers in Discord.
async function useRealBoardRuntime({ events = [], transport = null } = {}) {
  const store = new InMemoryBoardStore();
  // The lifecycle only needs a store that can list recoverable rounds; nothing is recovered in these tests.
  store.listRecoverable = async ({ now, limit }) => store.snapshot().sessions
    .filter((session) => ['lobby', 'active'].includes(session.status) && session.expiresAt > now)
    .slice(0, limit);
  const getActiveSession = store.getActiveSession.bind(store);
  store.getActiveSession = async (...args) => {
    events.push('board store lookup');
    return getActiveSession(...args);
  };
  const errors = [];
  let generated = 0;
  const runtime = createBoardDiscordRuntime({
    store,
    transport: transport || {
      async update() {},
      async messageExists() { events.push('discord message lookup'); return true; },
    },
    idFactory: () => `board-session-${++generated}`,
    seedFactory: () => `board-seed-${generated}`,
    clock: () => new Date('2026-09-30T00:00:00.000Z'),
    renderPngImpl: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
    runtimeLogger: { error(...values) { errors.push(values); } },
  });
  await resetBoardRuntimeForTests();
  configureBoardRuntime(runtime);
  return { runtime, store, errors, events };
}

test('board status 查詢棋類公開局：轉交棋盤 runtime 前先私密 defer，之後的回覆都走 editReply', async () => {
  const events = [];
  await useRealBoardRuntime({ events });
  const start = createBoardInteraction({ id: 'board-status-start', channelId: 'board-room', values: { game: 'chess' } });
  await boardCommand.execute(start.interaction);
  assert.equal(start.log.edits.length, 1, 'the real runtime opened a chess lobby');
  events.length = 0;

  const status = createBoardInteraction({
    id: 'board-status-chess', subcommand: 'status', channelId: 'board-room', values: { game: 'chess' },
  });
  const deferReply = status.interaction.deferReply.bind(status.interaction);
  status.interaction.deferReply = async (payload) => {
    events.push('defer');
    return deferReply(payload);
  };

  await boardCommand.execute(status.interaction);

  assert.equal(events[0], 'defer', 'acknowledged before the first board lookup');
  assert.ok(events.includes('board store lookup'));
  assert.ok(events.includes('discord message lookup'), 'the panel refresh talked to Discord after the defer');
  assert.deepEqual(status.log.deferred, [{ ephemeral: true }]);
  assert.equal(status.log.replies.length, 0);
  assert.equal(status.log.followUps.length, 0);
  assert.equal(status.log.edits.length, 1);
  assert.match(status.log.edits[0].content, /目前棋局：等待玩家/u);
  assert.deepEqual(status.log.edits[0].allowedMentions, { parse: [] });
});

test('board status 查詢棋類公開局時，頻道沒有這局或是另一種棋，錯誤回覆也以 editReply 取代 defer 的佔位', async () => {
  await useRealBoardRuntime();
  const start = createBoardInteraction({ id: 'board-absent-start', channelId: 'board-room-2', values: { game: 'chess' } });
  await boardCommand.execute(start.interaction);

  for (const [label, channelId, game] of [
    ['no board in the channel', 'empty-board-room', 'chess'],
    ['another game in the channel', 'board-room-2', 'gomoku'],
  ]) {
    const { interaction, log } = createBoardInteraction({
      id: `board-absent-${label}`, subcommand: 'status', channelId, values: { game },
    });

    await boardCommand.execute(interaction);

    assert.deepEqual(log.deferred, [{ ephemeral: true }], label);
    assert.equal(log.replies.length + log.followUps.length, 0, label);
    assert.deepEqual(log.edits.map((payload) => payload.content), ['目前頻道沒有這個公開遊戲。'], label);
  }
});

test('board status 在棋盤 runtime 於 defer 之後自己失敗時，它的錯誤回覆也以 editReply 取代佔位訊息', async () => {
  let lookupFails = false;
  const { errors } = await useRealBoardRuntime({
    transport: {
      async update() {},
      async messageExists() {
        if (lookupFails) throw Object.assign(new Error('synthetic Discord outage'), { code: 'SYNTHETIC_OUTAGE' });
        return true;
      },
    },
  });
  const start = createBoardInteraction({ id: 'board-outage-start', channelId: 'board-room-3', values: { game: 'chess' } });
  await boardCommand.execute(start.interaction);
  lookupFails = true;
  const status = createBoardInteraction({
    id: 'board-outage-status', subcommand: 'status', channelId: 'board-room-3', values: { game: 'chess' },
  });

  await boardCommand.execute(status.interaction);

  assert.deepEqual(status.log.deferred, [{ ephemeral: true }]);
  assert.equal(status.log.replies.length + status.log.followUps.length, 0);
  assert.deepEqual(status.log.edits.map((payload) => payload.content), ['小吉暫時無法處理這個棋盤操作，請稍後再試。']);
  assert.equal(errors.length, 1, 'the runtime logged its own failure');
});

test('v23 遷移遇到不相容結構會停止，且不把版本誤標為完成，也不改動資料庫檔案', async () => {
  await withCoinTransaction((api) => {
    api.run('DROP TABLE game_launch_receipts');
    api.run('CREATE TABLE game_launch_receipts (interaction_id TEXT PRIMARY KEY)');
    api.run("UPDATE coin_metadata SET value = '22' WHERE key = 'schema_version'");
  });
  resetCoinDatabaseForTests();
  const before = sha256File(process.env.COIN_DB_PATH);
  await assert.rejects(() => initializeCoinDatabase(), (error) =>
    error.name === 'CoinDatabaseError' && /防重結構升級失敗/u.test(error.message));
  assert.equal(sha256File(process.env.COIN_DB_PATH), before);
});
