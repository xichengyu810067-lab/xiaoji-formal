const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');

function stripV22TablesForLegacyFixture(db) {
  db.exec('PRAGMA foreign_keys = OFF');
  for (const table of [
    'coin_owner_campaign_history_classifications', 'coin_owner_campaign_history_reviews',
    'coin_owner_campaign_audience_members', 'coin_owner_campaign_recipients',
    'coin_owner_campaign_audiences', 'coin_owner_campaigns',
    'discord_game_actions', 'discord_game_rewards', 'discord_game_sessions',
    'coin_work_legacy_snapshot_items', 'coin_work_legacy_snapshots',
    'coin_work_legacy_settlements', 'coin_primary_cycle_penalty_appeals',
    'coin_primary_cycle_penalties', 'coin_primary_cycle_payroll',
    'coin_primary_job_cycles', 'coin_primary_jobs_global',
    'coin_operation_receipts', 'reward_grants_v2', 'coin_bank_accounts_global',
    'coin_bank_rates_global', 'coin_rate_history_global', 'chip_accounts_global',
    'coin_global_economy_migrations',
  ]) db.exec(`DROP TABLE IF EXISTS ${table}`);
}

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-coin-'));
const dbPath = path.join(tempDirectory, 'xiaoji.sqlite');

process.env.COIN_DB_PATH = dbPath;
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.XIAOJI_MEMORY_PATH = path.join(tempDirectory, 'xiaoji-memory.json');

const { initializeCoinDatabase, resetCoinDatabaseForTests, withCoinDatabase, withCoinTransaction } = require('../src/services/coinDatabase');
const {
  FEATURE_KEYS,
  claimFeatureOutbox,
  enqueueFeatureOutbox,
  getGuildFeatureSetting,
  grantRewardOnce,
  listFeatureHealth,
  listFeatureUsageForDate,
  listGuildFeatureSettings,
  markFeatureOutboxDelivered,
  recordFeatureUsage,
  retryFeatureOutbox,
  setFeatureHealth,
  setGuildFeatureSetting,
} = require('../src/services/featurePlatformService');
const {
  REACTION_EMOJI,
  buildReactionPayload,
  acceptWordChainMessage,
  getWordChainStatus,
  handleWordChainMessage,
  processWordChainReactionOutbox,
  startWordChain,
  stopWordChain,
  validateWord,
} = require('../src/services/wordChainService');
const {
  acceptNumberChainMessage,
  getNumberChainStatus,
  handleNumberChainMessage,
  startNumberChain,
  stopNumberChain,
} = require('../src/services/numberChainService');
const { evaluateNumberExpression, MAX_INPUT_LENGTH } = require('../src/services/numberExpressionService');
const { assertCorpusInvariant, getSuccessors, words } = require('../src/services/wordChainLexicon');
const { assertDailyRiddleCorpus, riddles, selectRiddleForDate } = require('../src/services/dailyRiddleCorpus');
const {
  claimDailyRiddleEvent,
  claimDailyRiddleSettlement,
  getDailyRiddleEvent,
  getNextRiddleBoundaryDelay,
  getRiddlePhase,
  handleDailyRiddleMessage,
  isCorrectDailyRiddleAnswer,
  isEligibleRiddleMessage,
  normalizeDailyRiddleAnswer,
  processDailyRiddleTick,
  publishDailyRiddle,
  recordDailyRiddleMessage,
  settleDailyRiddle,
  startDailyRiddleScheduler,
  stopDailyRiddleScheduler,
} = require('../src/services/dailyRiddleService');
const {
  assertDailyDiscussionCorpus,
  corpusVersion: discussionCorpusVersion,
  selectDiscussionForDate,
  topics: discussionTopics,
} = require('../src/services/dailyDiscussionCorpus');
const {
  claimDailyDiscussionEvent,
  claimDailyDiscussionSettlement,
  getDailyDiscussionEvent,
  getDiscussionWindow,
  getNextDiscussionBoundaryDelay,
  handleDailyDiscussionMessage,
  isEligibleDiscussionMessage,
  processDailyDiscussionTick,
  recordDailyDiscussionMessage,
  settleDailyDiscussion,
  startDailyDiscussionScheduler,
  stopDailyDiscussionScheduler,
} = require('../src/services/dailyDiscussionService');
const { createMessageFeatureRouter, routeMessageFeatures } = require('../src/services/messageFeatureRouter');
const coinAdminCommand = require('../src/commands/coin-admin');
const {
  CHAT_STYLE_NAMES,
  DEFAULT_CHAT_STYLE,
  getUserChatPreference,
  resolveUserChatPreference,
  setUserChatPreference,
} = require('../src/services/chatStyleService');
const chatStyleCommand = require('../src/commands/chat-style');
const {
  getUserRomancePreference,
  resolveUserRomancePreference,
  setUserRomancePreference,
} = require('../src/services/romanceModeService');
const romanceCommand = require('../src/commands/romance');
const { handleMentionMessage } = require('../src/services/mentionService');
const { clearMemoryForTests } = require('../src/services/memoryService');
const { clearConversationStateForTests } = require('../src/services/conversationModeService');
const {
  getNextTaipeiOccurrence,
  getTaipeiDateKey,
  getTaipeiDayRange,
  getTaipeiMinuteOfDay,
  isTaipeiTime,
} = require('../src/utils/taipeiClock');
const {
  CoinServiceError,
  ShopItemTypes,
  adjustPlayerBalance,
  createShopItem,
  dailyCheckin,
  getLeaderboard,
  getInventory,
  getPlayerBalance,
  getShopItem,
  purchaseItem,
} = require('../src/services/coinService');
const {
  buyChips,
  cashoutChips,
  creditChipsWithApi,
  getChipBalance,
} = require('../src/services/chipService');
const {
  createLuxuryItem,
  editLuxuryItem,
  getLuxuryInventory,
  pawnLuxuryItem,
  purchaseLuxuryItem,
  redeemPawnRecord,
} = require('../src/services/luxuryService');
const {
  createFixedDeposit,
  deposit,
  getAllBalanceSummaries,
  getBalanceSummary,
  listFixedDeposits,
  setFixedRate,
} = require('../src/services/bankService');
const {
  addPendingTask,
  deleteWorkSubmission,
  editWorkSubmission,
  getPayrollHistory,
  getPrimaryPayrollHistory,
  listWorkPenalties,
  listJobs,
  listWorkTasks,
  processDueJobs,
  processDuePrimaryCycles,
  processExpiredWorkTasks,
  createPrimaryPenaltyAppeal,
  reportWork,
  reviewPrimaryPenaltyAppeal,
  reviewWorkPenaltyAppeal,
  reviewWorkSubmission,
  createWorkPenaltyAppeal,
  startJob,
  startVenueJobs,
} = require('../src/services/workService');
const { verifyVenueMembers } = require('../src/platform/venueMembership');
const {
  VenueItemType,
  addVenueMenuItem,
  completeVenueOrderItem,
  createVenueOrder,
  getVenueRecipe,
  listVenueHistory,
  listVenueMenu,
  processExpiredVenueOrderItems,
  serveVenueOrder,
} = require('../src/services/venueService');
const {
  applyCasinoLoanRelief,
  collectCasinoDebt,
  getCasinoDebtStatus,
  getCasinoLoanStatus,
  getHandValue,
  hitBlackjack,
  listCasinoHistory,
  playBaccarat,
  playDice,
  playPoker,
  playRoulette,
  playSlots,
  borrowCasinoLoan,
  processExpiredBlackjackSessions,
  repayCasinoLoan,
  standBlackjack,
  startBlackjack,
} = require('../src/services/casinoService');
const {
  bookLodging,
  enterDuelTower,
  getDuelTowerProfile,
  listOwnedBattleWeapons,
} = require('../src/services/casinoFacilityService');

function createFakeRiddleDiscord({
  guildId = 'riddle-guild',
  parentId = 'riddle-parent',
  threadId = 'riddle-thread',
  unknownChannelErrorCode = null,
} = {}) {
  const parentMessages = new Map();
  const threadMessages = new Map();
  const channels = new Map();
  let nextMessageId = 1;
  let currentNowMs = Date.parse('2026-09-04T02:00:00.000Z');
  let threadStarts = 0;
  let threadDeletes = 0;
  let parentDeletes = 0;

  function orderedPage(messages, options = {}) {
    const values = [...messages.values()].sort((left, right) => right.createdTimestamp - left.createdTimestamp);
    const start = options.before ? values.findIndex((message) => message.id === options.before) + 1 : 0;
    return new Map(values.slice(start, start + (options.limit || 100)).map((message) => [message.id, message]));
  }

  function fetchFrom(messages) {
    return async (query) => {
      if (typeof query === 'string') return messages.get(query) || null;
      return orderedPage(messages, query);
    };
  }

  const thread = {
    id: threadId,
    messages: { fetch: fetchFrom(threadMessages) },
    async delete() {
      threadDeletes += 1;
      channels.delete(thread.id);
      return thread;
    },
    async send(payload) {
      const message = {
        id: `thread-bot-${nextMessageId++}`,
        author: { id: 'bot-user', bot: true },
        embeds: payload.embeds || [],
        content: payload.content || '',
        createdTimestamp: currentNowMs,
      };
      threadMessages.set(message.id, message);
      return message;
    },
  };

  const parent = {
    id: parentId,
    messages: { fetch: fetchFrom(parentMessages) },
    async send(payload) {
      const message = {
        id: `parent-bot-${nextMessageId++}`,
        author: { id: 'bot-user', bot: true },
        embeds: payload.embeds || [],
        content: payload.content || '',
        createdTimestamp: currentNowMs,
        thread: null,
        async delete() {
          parentDeletes += 1;
          parentMessages.delete(message.id);
          return message;
        },
        async startThread() {
          threadStarts += 1;
          message.thread = thread;
          channels.set(thread.id, thread);
          return thread;
        },
      };
      parentMessages.set(message.id, message);
      return message;
    },
  };
  channels.set(parent.id, parent);
  function fetchChannel(id) {
    const channel = channels.get(id);
    if (channel || unknownChannelErrorCode === null) return channel || null;
    const error = new Error(unknownChannelErrorCode === 10003 ? 'Unknown Channel' : 'Channel fetch failed');
    error.code = unknownChannelErrorCode;
    throw error;
  }
  const guild = {
    id: guildId,
    channels: {
      cache: { get: (id) => channels.get(id) },
      fetch: async (id) => fetchChannel(id),
    },
  };
  const client = {
    user: { id: 'bot-user' },
    guilds: {
      cache: { get: (id) => (id === guild.id ? guild : undefined) },
      fetch: async (id) => (id === guild.id ? guild : null),
    },
    channels: {
      cache: { get: (id) => channels.get(id) },
      fetch: async (id) => fetchChannel(id),
    },
  };

  return {
    client,
    guild,
    parent,
    parentMessages,
    thread,
    threadMessages,
    get threadStarts() { return threadStarts; },
    get threadDeletes() { return threadDeletes; },
    get parentDeletes() { return parentDeletes; },
    setNow(value) { currentNowMs = new Date(value).getTime(); },
    addParentMessage({ id, userId = 'bot-user', bot = true, content = '', embeds = [], createdAt }) {
      parentMessages.set(id, {
        id,
        author: { id: userId, bot },
        content,
        embeds,
        createdAt: new Date(createdAt),
        createdTimestamp: new Date(createdAt).getTime(),
      });
    },
    addHumanMessage({ id, userId, content, createdAt }) {
      threadMessages.set(id, {
        id,
        author: { id: userId, bot: false },
        content,
        embeds: [],
        createdAt: new Date(createdAt),
        createdTimestamp: new Date(createdAt).getTime(),
      });
    },
  };
}

function createManualV14RiddleDatabase(SQL, { incompatibleMessageSchema = false, orphanMessage = false } = {}) {
  const fixture = new SQL.Database();
  fixture.exec(`
    CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '14', '2026-01-01T00:00:00.000Z');
    CREATE TABLE daily_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      event_kind TEXT NOT NULL CHECK (event_kind IN ('riddle', 'discussion')),
      local_date TEXT NOT NULL,
      riddle_id TEXT,
      parent_channel_id TEXT NOT NULL,
      announcement_message_id TEXT,
      thread_id TEXT,
      answer_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'published', 'published_late', 'settling', 'settled', 'blocked', 'missed', 'failed')),
      window_start_at TEXT NOT NULL,
      window_end_at TEXT NOT NULL,
      publish_marker TEXT NOT NULL,
      answer_marker TEXT NOT NULL,
      published_at TEXT,
      history_reconciled_at TEXT,
      settled_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (guild_id, event_kind, local_date)
    );
    CREATE TABLE daily_event_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      guild_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      content_hash TEXT ${incompatibleMessageSchema ? '' : 'NOT NULL'} CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
      eligible INTEGER NOT NULL DEFAULT 0 CHECK (eligible IN (0, 1)),
      correct INTEGER NOT NULL DEFAULT 0 CHECK (correct IN (0, 1)),
      UNIQUE (event_id, message_id)
    );
    CREATE TABLE daily_event_participants (
      event_id INTEGER NOT NULL,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      eligible INTEGER NOT NULL DEFAULT 0 CHECK (eligible IN (0, 1)),
      correct INTEGER NOT NULL DEFAULT 0 CHECK (correct IN (0, 1)),
      participation_reward_status TEXT NOT NULL DEFAULT 'pending' CHECK (participation_reward_status IN ('pending', 'granted')),
      correct_reward_status TEXT NOT NULL DEFAULT 'pending' CHECK (correct_reward_status IN ('pending', 'granted', 'not_earned')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (event_id, user_id)
    );
    INSERT INTO daily_events
      (id, guild_id, event_kind, local_date, riddle_id, parent_channel_id, announcement_message_id, thread_id,
       answer_message_id, status, window_start_at, window_end_at, publish_marker, answer_marker, published_at,
       history_reconciled_at, settled_at, attempt_count, last_error, created_at, updated_at)
    VALUES
      (41, 'legacy-riddle-guild', 'riddle', '2026-08-01', 'r001', 'legacy-parent', 'legacy-announcement',
       'legacy-thread', NULL, 'settling', '2026-08-01T02:00:00.000Z', '2026-08-01T13:30:00.000Z',
       'legacy-publish-marker', 'legacy-answer-marker', '2026-08-01T02:00:00.000Z', NULL, NULL, 2,
       'legacy-error', '2026-08-01T02:00:00.000Z', '2026-08-01T13:30:00.000Z');
    INSERT INTO daily_event_messages
      (id, event_id, guild_id, thread_id, message_id, user_id, created_at, content_hash, eligible, correct)
    VALUES
      (77, 41, 'legacy-riddle-guild', 'legacy-thread', 'legacy-message', 'legacy-user',
       '2026-08-01T03:00:00.000Z', '${'a'.repeat(64)}', 1, 1);
    INSERT INTO daily_event_participants
      (event_id, guild_id, user_id, eligible, correct, participation_reward_status, correct_reward_status, created_at, updated_at)
    VALUES
      (41, 'legacy-riddle-guild', 'legacy-user', 1, 1, 'granted', 'pending',
       '2026-08-01T03:00:00.000Z', '2026-08-01T13:30:00.000Z');
    ${orphanMessage ? `INSERT INTO daily_event_messages
      (id, event_id, guild_id, thread_id, message_id, user_id, created_at, content_hash, eligible, correct)
      VALUES (78, 999, 'legacy-riddle-guild', 'legacy-thread', 'orphan-message', 'orphan-user',
       '2026-08-01T04:00:00.000Z', '${'b'.repeat(64)}', 1, 0);` : ''}
  `);
  return fixture;
}

function createManualV19WalletDatabase(SQL, playerRows) {
  const fixture = new SQL.Database();
  fixture.exec(`
    CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '19', '2026-08-01T00:00:00.000Z');
    CREATE TABLE coin_players (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0,
      bank_balance INTEGER NOT NULL DEFAULT 0,
      bank_interest_accrued REAL NOT NULL DEFAULT 0,
      last_interest_date TEXT,
      total_earned INTEGER NOT NULL DEFAULT 0,
      total_spent INTEGER NOT NULL DEFAULT 0,
      last_daily_date TEXT,
      daily_streak INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE coin_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      balance_before INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      operator_id TEXT,
      reason TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE reward_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      reward_kind TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      metadata TEXT,
      transaction_id INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE (guild_id, user_id, source_type, source_id, reward_kind)
    );
    CREATE TABLE wallet_migration_sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO wallet_migration_sentinel VALUES (1, 'keep-me');
  `);
  const statement = fixture.prepare(
    `INSERT INTO coin_players
      (guild_id, user_id, balance, bank_balance, bank_interest_accrued, last_interest_date,
       total_earned, total_spent, last_daily_date, daily_streak, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  try {
    for (const row of playerRows) statement.run(row);
  } finally {
    statement.free();
  }
  fixture.exec(`
    INSERT INTO coin_transactions
      (id, guild_id, user_id, type, balance_before, amount, balance_after, reason, created_at)
    VALUES (11, 'guild-a', 'shared-user', 'system_reward', 90, 10, 100, 'legacy reward', '2026-08-01T01:00:00.000Z');
    INSERT INTO reward_grants
      (id, guild_id, user_id, source_type, source_id, reward_kind, amount, transaction_id, created_at)
    VALUES (7, 'guild-a', 'shared-user', 'riddle', 'r1', 'correct', 10, 11, '2026-08-01T01:00:00.000Z');
  `);
  return fixture;
}

test.beforeEach(() => {
  stopDailyRiddleScheduler();
  resetCoinDatabaseForTests({ allowCreateOnNextOpen: true });

  if (fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { force: true });
  }
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

async function activatePrimaryForFixture(guildId, userId, jobName, dailySalary) {
  const selected = await startJob(guildId, userId, jobName, 1);
  const startsAt = new Date(Date.now() - 60_000).toISOString();
  const endsAt = new Date(Date.now() + 3_600_000).toISOString();
  await withCoinTransaction((api) => {
    api.run(
      "UPDATE coin_primary_jobs_global SET state = 'active', effective_from = ?, effective_until = ?, updated_at = ? WHERE user_id = ?",
      [startsAt, endsAt, startsAt, userId]
    );
    api.run(
      "INSERT INTO coin_primary_job_cycles (cycle_id,user_id,job_name,work_days,source_guild_id,starts_at,ends_at,salary_rule_version,salary_snapshot_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'active',?,?)",
      [selected.nextCycleId, userId, jobName, 1, guildId, startsAt, endsAt, 'primary-v1',
        JSON.stringify({ version: 'primary-v1', dailySalary, basicRatio: 0.75, translatorBonus: jobName === '翻譯官' ? 200 : 0 }),
        startsAt, startsAt]
    );
  });
  return selected.nextCycleId;
}

async function duePrimaryForFixture(cycleId) {
  await withCoinTransaction((api) => api.run(
    'UPDATE coin_primary_job_cycles SET ends_at = ? WHERE cycle_id = ?',
    [new Date(Date.now() - 1000).toISOString(), cycleId]
  ));
  return processDuePrimaryCycles();
}

async function verifiedVenueFixture(guildId, userIds, { completeRoster = false } = {}) {
  const members = new Map(userIds.map((id) => [id, { id, guild: { id: guildId }, user: { bot: false } }]));
  return verifyVenueMembers({
    id: guildId, memberCount: members.size,
    members: { async fetch(id) { return id ? members.get(id) : members; } },
  }, { userIds, completeRoster });
}

async function fundVenueFixture(guildId, userId, chips) {
  return withCoinTransaction((api) => creditChipsWithApi(api, guildId, userId, chips));
}

test('coin database auto-creates SQLite file and schema', async () => {
  const info = await initializeCoinDatabase();

  assert.equal(info.path, dbPath);
  assert.equal(info.createdDatabase, true);
  assert.equal(fs.existsSync(dbPath), true);
  assert.ok(info.createdTables.includes('coin_players'));
  assert.ok(info.createdTables.includes('coin_wallets'));
  assert.ok(info.createdTables.includes('coin_guild_players'));
  assert.ok(info.createdTables.includes('coin_wallet_migrations'));
  assert.ok(info.createdTables.includes('coin_transactions'));
  assert.ok(info.createdTables.includes('coin_admin_logs'));
  assert.ok(info.createdTables.includes('chip_accounts'));
  assert.ok(info.createdTables.includes('luxury_items'));
  assert.ok(info.createdTables.includes('casino_lodging_bookings'));
  assert.ok(info.createdTables.includes('casino_duel_tower_runs'));
  assert.ok(info.createdTables.includes('coin_work_penalties'));
  assert.ok(info.createdTables.includes('coin_work_penalty_appeals'));
  assert.equal(info.schemaVersion, 22);
  assert.ok(info.createdTables.includes('feature_guild_settings'));
  assert.ok(info.createdTables.includes('feature_outbox'));
  assert.ok(info.createdTables.includes('feature_outbox_dead_letters'));
  assert.ok(info.createdTables.includes('reward_grants'));
  assert.ok(info.createdTables.includes('feature_usage_daily'));
  assert.ok(info.createdTables.includes('feature_health'));
  assert.ok(info.createdTables.includes('user_chat_preferences'));
  assert.ok(info.createdTables.includes('user_romance_preferences'));
  assert.ok(info.createdTables.includes('game_sessions'));
  assert.ok(info.createdTables.includes('game_actions'));
  assert.ok(info.createdTables.includes('game_rewards'));
  assert.ok(info.createdTables.includes('github_releases'));
  assert.ok(info.createdTables.includes('release_announcement_deliveries'));
  assert.ok(info.createdTables.includes('text_chain_sessions'));
  assert.ok(info.createdTables.includes('text_chain_entries'));
  assert.ok(info.createdTables.includes('number_chain_sessions'));
  assert.ok(info.createdTables.includes('number_chain_entries'));
  assert.ok(info.createdTables.includes('daily_events'));
  assert.ok(info.createdTables.includes('daily_event_messages'));
  assert.ok(info.createdTables.includes('daily_event_participants'));

  const schema = await withCoinTransaction((api) => ({
    version: api.get("SELECT value FROM coin_metadata WHERE key = 'schema_version'").value,
    usageColumns: api.all('PRAGMA table_info(feature_usage_daily)').map((column) => column.name),
    releaseColumns: api.all('PRAGMA table_info(github_releases)').map((column) => column.name),
    deliveryColumns: api.all('PRAGMA table_info(release_announcement_deliveries)').map((column) => column.name),
  }));

  assert.equal(schema.version, '22');
  assert.deepEqual(schema.usageColumns, ['usage_date', 'feature_key', 'metric_key', 'usage_count', 'updated_at']);
  assert.deepEqual(schema.releaseColumns, [
    'release_id', 'repository', 'tag_name', 'version_major', 'version_minor', 'version_patch',
    'release_name', 'body_summary', 'html_url', 'metadata_digest', 'published_at', 'discovered_at', 'updated_at',
  ]);
  assert.deepEqual(schema.deliveryColumns, [
    'release_id', 'guild_id', 'status', 'attempt_count', 'next_attempt_at', 'lease_owner', 'lease_until',
    'last_error', 'nonce', 'delivered_at', 'created_at', 'updated_at',
  ]);
});

test('coin database migrates a v10 sentinel database to v21 without changing sentinel data', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const fixture = new SQL.Database();
  fixture.exec(`
    CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '10', '2026-01-01T00:00:00.000Z');
    CREATE TABLE sentinel_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO sentinel_records (id, value) VALUES (1, 'keep-me');
  `);
  fs.writeFileSync(dbPath, Buffer.from(fixture.export()));
  fixture.close();

  const info = await initializeCoinDatabase();
  const migrated = await withCoinTransaction((api) => ({
    version: api.get("SELECT value FROM coin_metadata WHERE key = 'schema_version'").value,
    sentinel: api.get('SELECT value FROM sentinel_records WHERE id = 1').value,
    featureTables: api
      .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'feature_%' ORDER BY name")
      .map((row) => row.name),
  }));

  assert.equal(info.existed, true);
  assert.equal(info.schemaVersion, 22);
  assert.equal(migrated.version, '22');
  assert.equal(migrated.sentinel, 'keep-me');
  assert.deepEqual(migrated.featureTables, [
    'feature_guild_settings',
    'feature_health',
    'feature_outbox',
    'feature_outbox_dead_letters',
    'feature_usage_daily',
  ]);
});

test('schema v20 sums legacy per-guild wallets once, preserves guild state, and blocks archive writes', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const taipeiToday = getTaipeiDateKey(new Date());
  const taipeiHour = getTaipeiMinuteOfDay(new Date()) / 60;
  const settlementDate = taipeiHour >= 23 ? taipeiToday :
    new Date(Date.parse(`${taipeiToday}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const fixture = createManualV19WalletDatabase(SQL, [
    ['guild-a', 'shared-user', 100, 7, 0.25, settlementDate, 140, 40, '2026-08-01', 3, '2026-07-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z'],
    ['guild-b', 'shared-user', 50, 9, 0.5, settlementDate, 80, 30, null, 0, '2026-07-02T00:00:00.000Z', '2026-08-02T01:00:00.000Z'],
    ['guild-a', 'guild-a-only', 25, 4, 0, settlementDate, 25, 0, null, 0, '2026-07-03T00:00:00.000Z', '2026-08-03T01:00:00.000Z'],
  ]);
  fs.writeFileSync(dbPath, Buffer.from(fixture.export()));
  fixture.close();

  const info = await initializeCoinDatabase();
  assert.equal(info.schemaVersion, 22);
  const migrated = await withCoinDatabase((api) => ({
    wallet: api.get("SELECT * FROM coin_wallets WHERE user_id = 'shared-user'"),
    guildPlayers: api.all("SELECT * FROM coin_guild_players WHERE user_id = 'shared-user' ORDER BY guild_id"),
    manifest: api.get('SELECT * FROM coin_wallet_migrations WHERE to_version = 20'),
    archiveCount: api.get('SELECT COUNT(*) AS count FROM coin_players').count,
    transaction: api.get('SELECT id, wallet_scope, wallet_revision FROM coin_transactions WHERE id = 11'),
    grant: api.get('SELECT id, transaction_id FROM reward_grants WHERE id = 7'),
    sentinel: api.get('SELECT value FROM wallet_migration_sentinel WHERE id = 1').value,
  }));

  assert.deepEqual(
    { balance: migrated.wallet.balance, earned: migrated.wallet.total_earned, spent: migrated.wallet.total_spent, revision: migrated.wallet.revision },
    { balance: 150, earned: 220, spent: 70, revision: 0 }
  );
  assert.deepEqual(
    migrated.guildPlayers.map((row) => [row.guild_id, row.bank_balance, row.last_daily_date, row.daily_streak]),
    [['guild-a', 7, '2026-08-01', 3], ['guild-b', 9, null, 0]]
  );
  assert.deepEqual(
    {
      rows: migrated.manifest.source_row_count,
      users: migrated.manifest.source_distinct_user_count,
      balance: migrated.manifest.source_balance_sum,
      earned: migrated.manifest.source_total_earned_sum,
      spent: migrated.manifest.source_total_spent_sum,
    },
    { rows: 3, users: 2, balance: 175, earned: 245, spent: 70 }
  );
  assert.match(migrated.manifest.source_sha256, /^[0-9a-f]{64}$/);
  assert.equal(migrated.archiveCount, 3);
  assert.deepEqual(migrated.transaction, { id: 11, wallet_scope: 'guild_legacy', wallet_revision: null });
  assert.deepEqual(migrated.grant, { id: 7, transaction_id: 11 });
  assert.equal(migrated.sentinel, 'keep-me');

  await assert.rejects(
    withCoinTransaction((api) => api.run("UPDATE coin_players SET balance = 999 WHERE guild_id = 'guild-a' AND user_id = 'shared-user'")),
    /read-only v19 archive/
  );

  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  const restarted = await withCoinDatabase((api) => ({
    wallet: api.get("SELECT balance, total_earned, total_spent FROM coin_wallets WHERE user_id = 'shared-user'"),
    manifests: api.get('SELECT COUNT(*) AS count FROM coin_wallet_migrations WHERE to_version = 20').count,
  }));
  assert.deepEqual(restarted.wallet, { balance: 150, total_earned: 220, total_spent: 70 });
  assert.equal(restarted.manifests, 1);
});

test('schema v20 rejects invalid legacy wallet values without changing the database bytes', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const fixture = createManualV19WalletDatabase(SQL, [
    ['guild-a', 'invalid-user', -1, 0, 0, null, 0, 0, null, 0, '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'],
  ]);
  fs.writeFileSync(dbPath, Buffer.from(fixture.export()));
  fixture.close();
  const before = fs.readFileSync(dbPath);

  await assert.rejects(initializeCoinDatabase(), /v20/);
  assert.deepEqual(fs.readFileSync(dbPath), before);
});

test('schema v20 rejects a cross-guild wallet SUM overflow without changing the database bytes', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const fixture = createManualV19WalletDatabase(SQL, [
    ['guild-a', 'overflow-user', Number.MAX_SAFE_INTEGER, 0, 0, null, 0, 0, null, 0, '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'],
    ['guild-b', 'overflow-user', 1, 0, 0, null, 0, 0, null, 0, '2026-07-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'],
  ]);
  fs.writeFileSync(dbPath, Buffer.from(fixture.export()));
  fixture.close();
  const before = fs.readFileSync(dbPath);

  await assert.rejects(initializeCoinDatabase(), /v20/);
  assert.deepEqual(fs.readFileSync(dbPath), before);
});

test('schema v20 rejects an incomplete authority schema without changing the database bytes', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  await initializeCoinDatabase();
  resetCoinDatabaseForTests();
  const fixture = new SQL.Database(fs.readFileSync(dbPath));
  fixture.exec('DROP INDEX idx_coin_transactions_global_wallet_revision');
  const before = Buffer.from(fixture.export());
  fs.writeFileSync(dbPath, before);
  fixture.close();

  await assert.rejects(initializeCoinDatabase(), /v20 結構不完整/);
  assert.deepEqual(fs.readFileSync(dbPath), before);
});

test('coin-admin global wallet mutations reject a non-owner even when invoked from a guild', async () => {
  const originalOwnerId = process.env.BOT_OWNER_ID;
  process.env.BOT_OWNER_ID = 'wallet-owner';
  try {
    for (const subcommand of ['add', 'remove', 'set', 'reset-user', 'campaign-preview', 'campaign-apply']) {
      let reply;
      await coinAdminCommand.execute({
        commandName: 'coin-admin',
        guildId: 'guild-a',
        user: { id: 'guild-admin', tag: 'guild-admin' },
        inGuild: () => true,
        options: { getSubcommand: () => subcommand },
        reply: async (payload) => { reply = payload; },
      });
      assert.deepEqual(reply, { content: '你沒有權限使用這個指令。', ephemeral: true });
    }
  } finally {
    if (originalOwnerId === undefined) delete process.env.BOT_OWNER_ID;
    else process.env.BOT_OWNER_ID = originalOwnerId;
  }
});

test('wallet, bank, chips, shops, and inventory are global while participation keeps source guild context', async () => {
  await adjustPlayerBalance('guild-a', 'shared-user', {
    action: 'set', amount: 2500, operatorId: 'owner', reason: 'cross-guild setup',
  });
  await getPlayerBalance('guild-b', 'shared-user');
  await adjustPlayerBalance('guild-a', 'guild-a-only', {
    action: 'set', amount: 900, operatorId: 'owner', reason: 'leaderboard scope setup',
  });
  const item = await createShopItem('guild-a', {
    name: 'Global badge', description: 'global catalog', price: 120, type: ShopItemTypes.COLLECTIBLE,
    stock: 2, purchaseLimit: 1, createdBy: 'owner',
  });
  assert.equal((await getShopItem('guild-b', item.id)).id, item.id);

  await purchaseItem('guild-a', 'shared-user', item.id, 1);
  const [guildA, guildB, inventoryA, inventoryB, leaderboardB] = await Promise.all([
    getPlayerBalance('guild-a', 'shared-user'),
    getPlayerBalance('guild-b', 'shared-user'),
    getInventory('guild-a', 'shared-user'),
    getInventory('guild-b', 'shared-user'),
    getLeaderboard('guild-b'),
  ]);
  assert.equal(guildA.balance, 2380);
  assert.equal(guildB.balance, 2380);
  assert.equal(guildA.revision, guildB.revision);
  assert.equal(inventoryA.length, 1);
  assert.equal(inventoryB.length, 1);
  assert.deepEqual(leaderboardB.players.map((player) => player.userId), ['shared-user']);

  await deposit('guild-a', 'shared-user', 1500);
  const [bankA, bankB] = await Promise.all([
    getBalanceSummary('guild-a', 'shared-user'),
    getBalanceSummary('guild-b', 'shared-user'),
  ]);
  assert.equal(bankA.walletBalance, 880);
  assert.equal(bankB.walletBalance, 880);
  assert.equal(bankA.bankBalance, 1500);
  assert.equal(bankB.bankBalance, 1500);

  await buyChips('guild-a', 'shared-user', 40);
  await borrowCasinoLoan('guild-a', 'shared-user', {
    amount: 1000,
    date: new Date('2026-08-04T00:00:00.000Z'),
  });
  const [chipsA, chipsB, loanA, loanB] = await Promise.all([
    getChipBalance('guild-a', 'shared-user'),
    getChipBalance('guild-b', 'shared-user'),
    getCasinoLoanStatus('guild-a', 'shared-user', { date: new Date('2026-08-04T00:00:00.000Z') }),
    getCasinoLoanStatus('guild-b', 'shared-user', { date: new Date('2026-08-04T00:00:00.000Z') }),
  ]);
  assert.equal(chipsA.balance, 1040);
  assert.equal(chipsB.balance, 1040);
  assert.equal(loanA.loan.currentDebtAmount, 1000);
  assert.equal(loanB.loan.currentDebtAmount, 1000);

  await createFixedDeposit('guild-a', 'shared-user', { amount: 1000, termDays: 7, source: 'bank' });
  assert.equal((await listFixedDeposits('guild-a', { userId: 'shared-user' })).length, 1);
  assert.equal((await listFixedDeposits('guild-b', { userId: 'shared-user' })).length, 1);

  const luxury = await createLuxuryItem('guild-a', {
    name: 'Global luxury', description: 'global luxury', price: 20, stock: 1,
    purchaseLimit: 1, createdBy: 'owner',
  });
  await purchaseLuxuryItem('guild-b', 'shared-user', luxury.id, 1);
  assert.equal((await getLuxuryInventory('guild-a', 'shared-user')).items.length, 1);
  assert.equal((await getLuxuryInventory('guild-b', 'shared-user')).items.length, 1);
  const finalWalletB = await getPlayerBalance('guild-b', 'shared-user');
  assert.equal(finalWalletB.balance, 820);

  const latest = await withCoinDatabase((api) => api.get(
    "SELECT guild_id, wallet_scope, wallet_revision, amount, balance_after FROM coin_transactions WHERE user_id = 'shared-user' ORDER BY id DESC LIMIT 1"
  ));
  assert.equal(latest.guild_id, 'guild-b');
  assert.equal(latest.wallet_scope, 'global');
  assert.equal(latest.amount, -20);
  assert.equal(latest.balance_after, 820);
  assert.ok(latest.wallet_revision >= 6);
});

test('coin database reconciles legacy multi-active word-chain sessions without dropping sessions or entries', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const fixture = new SQL.Database();
  fixture.exec(`
    CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '12', '2026-01-01T00:00:00.000Z');
    CREATE TABLE text_chain_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'stopped')),
      current_word TEXT NOT NULL, last_word TEXT NOT NULL, last_user_id TEXT,
      started_by TEXT NOT NULL, stopped_by TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, stopped_at TEXT, revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE text_chain_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL,
      guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL, word TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE feature_guild_settings (
      guild_id TEXT NOT NULL, feature_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      channel_id TEXT, config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, feature_key)
    );
    INSERT INTO text_chain_sessions (id, guild_id, channel_id, status, current_word, last_word, started_by, created_at, updated_at) VALUES
      (1, 'legacy-guild', 'channel-old', 'active', '安心', '安心', 'legacy-admin', '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
      (2, 'legacy-guild', 'channel-tie-loser', 'active', '心意', '心意', 'legacy-admin', '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z'),
      (3, 'legacy-guild', 'channel-retained', 'active', '意見', '意見', 'legacy-admin', '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z'),
      (4, 'legacy-guild', 'channel-stopped', 'stopped', '白雲', '白雲', 'legacy-admin', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
      (5, 'other-guild', 'other-channel', 'active', '不安', '不安', 'legacy-admin', '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z');
    INSERT INTO text_chain_entries (session_id, guild_id, channel_id, message_id, user_id, word, created_at) VALUES
      (1, 'legacy-guild', 'channel-old', 'legacy-message-1', 'user-1', '安心', '2026-01-03T00:00:00.000Z'),
      (2, 'legacy-guild', 'channel-tie-loser', 'legacy-message-2', 'user-2', '心意', '2026-01-04T00:00:00.000Z'),
      (3, 'legacy-guild', 'channel-retained', 'legacy-message-3', 'user-3', '意見', '2026-01-04T00:00:00.000Z'),
      (4, 'legacy-guild', 'channel-stopped', 'legacy-message-4', 'user-4', '白雲', '2026-01-02T00:00:00.000Z'),
      (5, 'other-guild', 'other-channel', 'legacy-message-5', 'user-5', '不安', '2026-01-05T00:00:00.000Z');
    INSERT INTO feature_guild_settings (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at) VALUES
      ('legacy-guild', 'word_chain', 1, 'channel-old', '{"legacy":true}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('inactive-guild', 'word_chain', 1, 'stale-channel', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  fs.writeFileSync(dbPath, Buffer.from(fixture.export()));
  fixture.close();

  await initializeCoinDatabase();
  const migrated = await withCoinDatabase((api) => ({
    sessions: api.all('SELECT id, guild_id, channel_id, status, current_word, completed_at FROM text_chain_sessions ORDER BY id'),
    entries: api.all('SELECT session_id, message_id FROM text_chain_entries ORDER BY id'),
    settings: api.all("SELECT guild_id, enabled, channel_id FROM feature_guild_settings WHERE feature_key = 'word_chain' ORDER BY guild_id"),
    columns: api.all('PRAGMA table_info(text_chain_sessions)').map((column) => column.name),
    index: api.get("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_text_chain_one_active_guild'").sql,
  }));
  assert.deepEqual(migrated.sessions, [
    { id: 1, guild_id: 'legacy-guild', channel_id: 'channel-old', status: 'stopped', current_word: '安心', completed_at: null },
    { id: 2, guild_id: 'legacy-guild', channel_id: 'channel-tie-loser', status: 'stopped', current_word: '心意', completed_at: null },
    { id: 3, guild_id: 'legacy-guild', channel_id: 'channel-retained', status: 'active', current_word: '意見', completed_at: null },
    { id: 4, guild_id: 'legacy-guild', channel_id: 'channel-stopped', status: 'stopped', current_word: '白雲', completed_at: null },
    { id: 5, guild_id: 'other-guild', channel_id: 'other-channel', status: 'active', current_word: '不安', completed_at: null },
  ]);
  assert.deepEqual(migrated.entries, [
    { session_id: 1, message_id: 'legacy-message-1' },
    { session_id: 2, message_id: 'legacy-message-2' },
    { session_id: 3, message_id: 'legacy-message-3' },
    { session_id: 4, message_id: 'legacy-message-4' },
    { session_id: 5, message_id: 'legacy-message-5' },
  ]);
  assert.deepEqual(migrated.settings, [
    { guild_id: 'inactive-guild', enabled: 0, channel_id: null },
    { guild_id: 'legacy-guild', enabled: 1, channel_id: 'channel-retained' },
    { guild_id: 'other-guild', enabled: 1, channel_id: 'other-channel' },
  ]);
  assert.ok(migrated.columns.includes('completed_at'));
  assert.match(migrated.index, /UNIQUE INDEX idx_text_chain_one_active_guild/i);

  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  const reopened = await withCoinDatabase((api) => ({
    sessions: api.all('SELECT id, status FROM text_chain_sessions ORDER BY id'),
    settings: api.all("SELECT guild_id, enabled, channel_id FROM feature_guild_settings WHERE feature_key = 'word_chain' ORDER BY guild_id"),
  }));
  assert.deepEqual(reopened.sessions, migrated.sessions.map(({ id, status }) => ({ id, status })));
  assert.deepEqual(reopened.settings, migrated.settings);
});

test('coin database rejects corrupt input without overwriting it', async () => {
  const corruptBytes = Buffer.from('not-a-sqlite-database');
  fs.writeFileSync(dbPath, corruptBytes);

  await assert.rejects(() => initializeCoinDatabase(), /讀取失敗|完整性檢查失敗/);
  assert.deepEqual(fs.readFileSync(dbPath), corruptBytes);
});

test('v12 migration fails closed when an incompatible foundation table already exists', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const fixture = new SQL.Database();
  fixture.exec(`
    CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '10', '2026-01-01T00:00:00.000Z');
    CREATE TABLE feature_outbox (id INTEGER PRIMARY KEY);
  `);
  const originalBytes = Buffer.from(fixture.export());
  fs.writeFileSync(dbPath, originalBytes);
  fixture.close();

  await assert.rejects(() => initializeCoinDatabase(), /資料庫升級失敗/);
  assert.deepEqual(fs.readFileSync(dbPath), originalBytes);
});

test('v12 schema verification rejects complete foundation tables with unsafe defaults or missing checks', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const fixtures = [
    {
      name: 'enabled default is on',
      definition: `
        CREATE TABLE feature_guild_settings (
          guild_id TEXT NOT NULL,
          feature_key TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          channel_id TEXT,
          config_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (guild_id, feature_key)
        );`,
    },
    {
      name: 'outbox status check is missing',
      definition: `
        CREATE TABLE feature_outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          feature_key TEXT NOT NULL,
          event_type TEXT NOT NULL,
          dedupe_key TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          available_at TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          claimed_by TEXT,
          claimed_at TEXT,
          lease_until TEXT,
          delivered_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (guild_id, feature_key, event_type, dedupe_key)
        );`,
    },
  ];

  for (const fixtureCase of fixtures) {
    resetCoinDatabaseForTests();
    fs.rmSync(dbPath, { force: true });
    const fixture = new SQL.Database();
    fixture.exec(`
      CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '10', '2026-01-01T00:00:00.000Z');
      ${fixtureCase.definition}
    `);
    const originalBytes = Buffer.from(fixture.export());
    fs.writeFileSync(dbPath, originalBytes);
    fixture.close();

    await assert.rejects(() => initializeCoinDatabase(), /v20 結構驗證失敗/);
    const finalBytes = fs.readFileSync(dbPath);
    const reopened = new SQL.Database(finalBytes);
    const version = reopened.exec("SELECT value FROM coin_metadata WHERE key = 'schema_version'")[0].values[0][0];
    reopened.close();

    assert.deepEqual(finalBytes, originalBytes, fixtureCase.name);
    assert.equal(version, '10', fixtureCase.name);
  }
});

test('v11 to v15 migration adds community tables and fails closed for an unsafe same-named table', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  await initializeCoinDatabase();
  resetCoinDatabaseForTests();
  const priorV12 = new SQL.Database(fs.readFileSync(dbPath));
  stripV22TablesForLegacyFixture(priorV12);
  priorV12.exec(`
    DROP TABLE text_chain_entries;
    DROP TABLE text_chain_sessions;
    DROP TRIGGER coin_players_v19_archive_no_insert;
    DROP TRIGGER coin_players_v19_archive_no_update;
    DROP TRIGGER coin_players_v19_archive_no_delete;
    DROP TABLE coin_guild_players;
    DROP TABLE coin_wallets;
    DROP TABLE coin_wallet_migrations;
    UPDATE coin_metadata SET value = '11' WHERE key = 'schema_version';
  `);
  fs.writeFileSync(dbPath, Buffer.from(priorV12.export()));
  priorV12.close();

  const migrated = await initializeCoinDatabase();
  assert.equal(migrated.schemaVersion, 22);
  assert.deepEqual(
    await withCoinDatabase((api) =>
      api.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'text_chain_%' ORDER BY name").map((row) => row.name)
    ),
    ['text_chain_entries', 'text_chain_sessions']
  );
  assert.deepEqual(
    await withCoinDatabase((api) =>
      api.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'number_chain_%' ORDER BY name").map((row) => row.name)
    ),
    ['number_chain_entries', 'number_chain_sessions']
  );

  resetCoinDatabaseForTests();
  const fixture = new SQL.Database();
  fixture.exec(`
    CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '11', '2026-01-01T00:00:00.000Z');
    CREATE TABLE text_chain_entries (id INTEGER PRIMARY KEY);
  `);
  const originalBytes = Buffer.from(fixture.export());
  fs.writeFileSync(dbPath, originalBytes);
  fixture.close();

  await assert.rejects(() => initializeCoinDatabase(), /資料庫升級失敗/);
  assert.deepEqual(fs.readFileSync(dbPath), originalBytes);
});

test('number-chain v13 migration reconciles legacy multi-active sessions before enforcing its unique index', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const fixture = new SQL.Database();
  fixture.exec(`
    CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '12', '2026-01-01T00:00:00.000Z');
    CREATE TABLE feature_guild_settings (
      guild_id TEXT NOT NULL, feature_key TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      channel_id TEXT, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, feature_key)
    );
    CREATE TABLE number_chain_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
      expected_target INTEGER NOT NULL CHECK (expected_target >= 1 AND expected_target <= 9007199254740991),
      last_user_id TEXT, revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0), started_by TEXT NOT NULL,
      stopped_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, stopped_at TEXT
    );
    CREATE TABLE number_chain_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, expression TEXT NOT NULL,
      result INTEGER NOT NULL CHECK (result >= 1 AND result <= 9007199254740991), created_at TEXT NOT NULL
    );
    INSERT INTO number_chain_sessions (id, guild_id, channel_id, status, expected_target, started_by, created_at, updated_at) VALUES
      (1, 'number-legacy', 'old', 'active', 15, 'admin', '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
      (2, 'number-legacy', 'tie-loser', 'active', 16, 'admin', '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z'),
      (3, 'number-legacy', 'retained', 'active', 17, 'admin', '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z'),
      (4, 'number-legacy', 'stopped', 'stopped', 18, 'admin', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
      (5, 'number-other', 'other', 'active', 1, 'admin', '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z');
    INSERT INTO number_chain_entries (session_id, guild_id, channel_id, message_id, user_id, expression, result, created_at) VALUES
      (1, 'number-legacy', 'old', 'number-legacy-1', 'u1', '15', 15, '2026-01-03T00:00:00.000Z'),
      (2, 'number-legacy', 'tie-loser', 'number-legacy-2', 'u2', '16', 16, '2026-01-04T00:00:00.000Z'),
      (3, 'number-legacy', 'retained', 'number-legacy-3', 'u3', '17', 17, '2026-01-04T00:00:00.000Z'),
      (4, 'number-legacy', 'stopped', 'number-legacy-4', 'u4', '18', 18, '2026-01-02T00:00:00.000Z'),
      (5, 'number-other', 'other', 'number-legacy-5', 'u5', '1', 1, '2026-01-05T00:00:00.000Z');
    INSERT INTO feature_guild_settings (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at) VALUES
      ('number-legacy', 'number_chain', 1, 'old', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('number-inactive', 'number_chain', 1, 'stale', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  fs.writeFileSync(dbPath, Buffer.from(fixture.export()));
  fixture.close();

  await initializeCoinDatabase();
  const migrated = await withCoinDatabase((api) => ({
    sessions: api.all('SELECT id, guild_id, channel_id, status, expected_target, completed_at FROM number_chain_sessions ORDER BY id'),
    entries: api.all('SELECT session_id, message_id FROM number_chain_entries ORDER BY id'),
    settings: api.all("SELECT guild_id, enabled, channel_id FROM feature_guild_settings WHERE feature_key = 'number_chain' ORDER BY guild_id"),
    activeIndex: api.get("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_number_chain_one_active_guild'").sql,
  }));
  assert.deepEqual(migrated.sessions, [
    { id: 1, guild_id: 'number-legacy', channel_id: 'old', status: 'stopped', expected_target: 15, completed_at: null },
    { id: 2, guild_id: 'number-legacy', channel_id: 'tie-loser', status: 'stopped', expected_target: 16, completed_at: null },
    { id: 3, guild_id: 'number-legacy', channel_id: 'retained', status: 'active', expected_target: 17, completed_at: null },
    { id: 4, guild_id: 'number-legacy', channel_id: 'stopped', status: 'stopped', expected_target: 18, completed_at: null },
    { id: 5, guild_id: 'number-other', channel_id: 'other', status: 'active', expected_target: 1, completed_at: null },
  ]);
  assert.equal(migrated.entries.length, 5);
  assert.deepEqual(migrated.settings, [
    { guild_id: 'number-inactive', enabled: 0, channel_id: null },
    { guild_id: 'number-legacy', enabled: 1, channel_id: 'retained' },
    { guild_id: 'number-other', enabled: 1, channel_id: 'other' },
  ]);
  assert.match(migrated.activeIndex, /UNIQUE INDEX idx_number_chain_one_active_guild/i);

  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  assert.deepEqual(
    await withCoinDatabase((api) => api.all('SELECT id, status FROM number_chain_sessions ORDER BY id')),
    migrated.sessions.map(({ id, status }) => ({ id, status }))
  );
});

test('number-chain v13 migration rejects unsafe same-named tables without changing bytes', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const fixture = new SQL.Database();
  fixture.exec(`
    CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '12', '2026-01-01T00:00:00.000Z');
    CREATE TABLE number_chain_sessions (id INTEGER PRIMARY KEY);
  `);
  const originalBytes = Buffer.from(fixture.export());
  fs.writeFileSync(dbPath, originalBytes);
  fixture.close();

  await assert.rejects(() => initializeCoinDatabase(), /資料庫升級失敗/);
  assert.deepEqual(fs.readFileSync(dbPath), originalBytes);
});

test('daily-riddle v15 bootstrap preserves v13 data, is idempotent, and fails closed on an unsafe table', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  await initializeCoinDatabase();
  resetCoinDatabaseForTests();
  const priorV13 = new SQL.Database(fs.readFileSync(dbPath));
  stripV22TablesForLegacyFixture(priorV13);
  priorV13.exec(`
    DROP TABLE daily_event_messages;
    DROP TABLE daily_event_participants;
    DROP TABLE daily_events;
    DROP TRIGGER coin_players_v19_archive_no_insert;
    DROP TRIGGER coin_players_v19_archive_no_update;
    DROP TRIGGER coin_players_v19_archive_no_delete;
    DROP TABLE coin_guild_players;
    DROP TABLE coin_wallets;
    DROP TABLE coin_wallet_migrations;
    CREATE TABLE riddle_migration_sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO riddle_migration_sentinel (id, value) VALUES (1, 'preserve-v13');
    UPDATE coin_metadata SET value = '13' WHERE key = 'schema_version';
  `);
  fs.writeFileSync(dbPath, Buffer.from(priorV13.export()));
  priorV13.close();

  const migrated = await initializeCoinDatabase();
  assert.equal(migrated.schemaVersion, 22);
  const migratedState = await withCoinDatabase((api) => ({
      version: api.get("SELECT value FROM coin_metadata WHERE key = 'schema_version'").value,
      sentinel: api.get('SELECT value FROM riddle_migration_sentinel WHERE id = 1').value,
      tables: api
        .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'daily_event%' ORDER BY name")
        .map((row) => row.name),
      eventColumns: api.all('PRAGMA table_info(daily_events)').map((column) => column.name),
      messageColumns: api.all('PRAGMA table_info(daily_event_messages)').map((column) => column.name),
    }));
  assert.deepEqual(
    { version: migratedState.version, sentinel: migratedState.sentinel, tables: migratedState.tables },
    {
      version: '22',
      sentinel: 'preserve-v13',
      tables: ['daily_event_messages', 'daily_event_participants', 'daily_events'],
    }
  );
  assert.ok(['publish_lease_owner', 'publish_lease_until', 'settle_lease_owner', 'settle_lease_until']
    .every((column) => migratedState.eventColumns.includes(column)));
  assert.equal(migratedState.messageColumns.includes('content'), false);
  assert.equal(migratedState.messageColumns.includes('content_hash'), false);
  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  assert.equal(
    Number(await withCoinDatabase((api) => api.get('SELECT COUNT(*) AS count FROM riddle_migration_sentinel').count)),
    1
  );

  resetCoinDatabaseForTests();
  const unsafe = new SQL.Database();
  unsafe.exec(`
    CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '13', '2026-01-01T00:00:00.000Z');
    CREATE TABLE daily_events (id INTEGER PRIMARY KEY);
  `);
  const originalBytes = Buffer.from(unsafe.export());
  fs.writeFileSync(dbPath, originalBytes);
  unsafe.close();
  await assert.rejects(() => initializeCoinDatabase(), /資料庫升級失敗/);
  assert.deepEqual(fs.readFileSync(dbPath), originalBytes);
});

test('daily-riddle v15 rebuild migrates a manual legacy v14 database without losing ids or links', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const fixture = createManualV14RiddleDatabase(SQL);
  fs.writeFileSync(dbPath, Buffer.from(fixture.export()));
  fixture.close();

  const info = await initializeCoinDatabase();
  assert.equal(info.schemaVersion, 22);
  const migrated = await withCoinDatabase((api) => ({
    version: api.get("SELECT value FROM coin_metadata WHERE key = 'schema_version'").value,
    event: api.get(`SELECT id, guild_id, status, attempt_count, last_error,
      publish_lease_owner, publish_lease_until, settle_lease_owner, settle_lease_until
      FROM daily_events WHERE id = 41`),
    message: api.get('SELECT id, event_id, message_id, user_id, eligible, correct FROM daily_event_messages WHERE id = 77'),
    participant: api.get(`SELECT event_id, user_id, participation_reward_status, correct_reward_status
      FROM daily_event_participants WHERE event_id = 41 AND user_id = 'legacy-user'`),
    messageColumns: api.all('PRAGMA table_info(daily_event_messages)').map((column) => column.name),
    orphanMessages: api.get(`SELECT COUNT(*) AS count FROM daily_event_messages AS message
      LEFT JOIN daily_events AS event ON event.id = message.event_id WHERE event.id IS NULL`).count,
    orphanParticipants: api.get(`SELECT COUNT(*) AS count FROM daily_event_participants AS participant
      LEFT JOIN daily_events AS event ON event.id = participant.event_id WHERE event.id IS NULL`).count,
    integrity: api.get('PRAGMA integrity_check').integrity_check,
  }));
  assert.equal(migrated.version, '22');
  assert.deepEqual(migrated.event, {
    id: 41,
    guild_id: 'legacy-riddle-guild',
    status: 'settling',
    attempt_count: 2,
    last_error: 'legacy-error',
    publish_lease_owner: null,
    publish_lease_until: null,
    settle_lease_owner: null,
    settle_lease_until: null,
  });
  assert.deepEqual(migrated.message, {
    id: 77, event_id: 41, message_id: 'legacy-message', user_id: 'legacy-user', eligible: 1, correct: 1,
  });
  assert.deepEqual(migrated.participant, {
    event_id: 41,
    user_id: 'legacy-user',
    participation_reward_status: 'granted',
    correct_reward_status: 'pending',
  });
  assert.equal(migrated.messageColumns.includes('content_hash'), false);
  assert.equal(Number(migrated.orphanMessages), 0);
  assert.equal(Number(migrated.orphanParticipants), 0);
  assert.equal(migrated.integrity, 'ok');

  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  assert.deepEqual(
    await withCoinDatabase((api) => ({
      version: api.get("SELECT value FROM coin_metadata WHERE key = 'schema_version'").value,
      eventCount: api.get('SELECT COUNT(*) AS count FROM daily_events').count,
      messageCount: api.get('SELECT COUNT(*) AS count FROM daily_event_messages').count,
      participantCount: api.get('SELECT COUNT(*) AS count FROM daily_event_participants').count,
    })),
    { version: '22', eventCount: 1, messageCount: 1, participantCount: 1 }
  );
});

test('daily-riddle v15 migration leaves legacy v14 bytes and version untouched on incompatible shape or orphan data', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  for (const fixtureOptions of [{ incompatibleMessageSchema: true }, { orphanMessage: true }]) {
    resetCoinDatabaseForTests();
    fs.rmSync(dbPath, { force: true });
    const fixture = createManualV14RiddleDatabase(SQL, fixtureOptions);
    const originalBytes = Buffer.from(fixture.export());
    fs.writeFileSync(dbPath, originalBytes);
    fixture.close();

    await assert.rejects(() => initializeCoinDatabase(), /資料庫升級失敗/);
    assert.deepEqual(fs.readFileSync(dbPath), originalBytes);
    const reopened = new SQL.Database(fs.readFileSync(dbPath));
    const version = reopened.exec("SELECT value FROM coin_metadata WHERE key = 'schema_version'")[0].values[0][0];
    reopened.close();
    assert.equal(version, '14');
  }
});

test('chat-style v16 migration is additive, restart-idempotent, and preserves failures byte-for-byte', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  await initializeCoinDatabase();
  resetCoinDatabaseForTests();
  const priorV15 = new SQL.Database(fs.readFileSync(dbPath));
  stripV22TablesForLegacyFixture(priorV15);
  priorV15.exec(`
    DROP TABLE user_chat_preferences;
    DROP TRIGGER coin_players_v19_archive_no_insert;
    DROP TRIGGER coin_players_v19_archive_no_update;
    DROP TRIGGER coin_players_v19_archive_no_delete;
    DROP TABLE coin_guild_players;
    DROP TABLE coin_wallets;
    DROP TABLE coin_wallet_migrations;
    CREATE TABLE chat_style_migration_sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO chat_style_migration_sentinel (id, value) VALUES (1, 'preserve-v15');
    UPDATE coin_metadata SET value = '15' WHERE key = 'schema_version';
  `);
  fs.writeFileSync(dbPath, Buffer.from(priorV15.export()));
  priorV15.close();

  const info = await initializeCoinDatabase();
  const migrated = await withCoinDatabase((api) => ({
    version: api.get("SELECT value FROM coin_metadata WHERE key = 'schema_version'").value,
    sentinel: api.get('SELECT value FROM chat_style_migration_sentinel WHERE id = 1').value,
    columns: api.all('PRAGMA table_info(user_chat_preferences)').map((column) => column.name),
    definition: api.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_chat_preferences'").sql,
  }));
  assert.equal(info.schemaVersion, 22);
  assert.deepEqual(migrated.columns, ['user_id', 'style', 'updated_at']);
  assert.equal(migrated.version, '22');
  assert.equal(migrated.sentinel, 'preserve-v15');
  assert.match(migrated.definition, /CHECK \(style IN \('cute', 'mature_sister', 'ceo', 'cold', 'tsundere', 'yandere'\)\)/);

  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  assert.equal(Number(await withCoinDatabase((api) => api.get(
    'SELECT COUNT(*) AS count FROM chat_style_migration_sentinel'
  ).count)), 1);

  for (const fixtureCase of [
    {
      version: '15',
      extra: 'CREATE TABLE user_chat_preferences (user_id TEXT PRIMARY KEY, style TEXT NOT NULL, updated_at TEXT NOT NULL);',
      message: /v20 結構驗證失敗/,
    },
    { version: '23', extra: '', message: /不支援/ },
  ]) {
    resetCoinDatabaseForTests();
    fs.rmSync(dbPath, { force: true });
    const fixture = new SQL.Database();
    fixture.exec(`
      CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '${fixtureCase.version}', '2026-01-01T00:00:00.000Z');
      ${fixtureCase.extra}
    `);
    const originalBytes = Buffer.from(fixture.export());
    fs.writeFileSync(dbPath, originalBytes);
    fixture.close();
    await assert.rejects(() => initializeCoinDatabase(), fixtureCase.message);
    assert.deepEqual(fs.readFileSync(dbPath), originalBytes);
  }
});

test('chat-style preferences default cute, persist globally, isolate users, and serialize concurrent writes', async () => {
  await initializeCoinDatabase();
  const initial = await getUserChatPreference('style-user');
  assert.equal(initial.style, DEFAULT_CHAT_STYLE);
  assert.equal(initial.persisted, false);

  await setUserChatPreference('style-user', 'mature_sister', { now: new Date('2026-09-03T01:00:00.000Z') });
  assert.equal((await getUserChatPreference('style-user')).style, 'mature_sister');
  assert.equal((await getUserChatPreference('different-user')).style, 'cute');

  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  assert.equal((await getUserChatPreference('style-user')).style, 'mature_sister');

  await Promise.all([
    setUserChatPreference('style-user', 'cold', { now: new Date('2026-09-03T02:00:00.000Z') }),
    setUserChatPreference('style-user', 'tsundere', { now: new Date('2026-09-03T02:00:01.000Z') }),
  ]);
  assert.equal((await getUserChatPreference('style-user')).style, 'tsundere');
  assert.deepEqual(CHAT_STYLE_NAMES, ['cute', 'mature_sister', 'ceo', 'cold', 'tsundere', 'yandere']);
  const columns = await withCoinDatabase((api) => api.all('PRAGMA table_info(user_chat_preferences)').map((column) => column.name));
  assert.deepEqual(columns, ['user_id', 'style', 'updated_at']);
});

test('chat-style malformed data and read failure fail safe to cute without exposing an identifier', async () => {
  await initializeCoinDatabase();
  await withCoinTransaction((api) => {
    api.run('PRAGMA ignore_check_constraints = ON');
    api.run(
      'INSERT INTO user_chat_preferences (user_id, style, updated_at) VALUES (?, ?, ?)',
      ['malformed-style-user', 'unsafe-style', '2026-09-03T00:00:00.000Z']
    );
    api.run('PRAGMA ignore_check_constraints = OFF');
  });
  const malformed = await getUserChatPreference('malformed-style-user');
  assert.equal(malformed.style, 'cute');
  assert.equal(malformed.malformed, true);

  const warnings = [];
  const health = [];
  const safe = await resolveUserChatPreference('123456789012345678', {
    reader: async () => { throw new Error('synthetic database failure'); },
    healthReporter: async (...args) => { health.push(args); },
    loggerImpl: { warn: (message) => warnings.push(message) },
  });
  assert.equal(safe.style, 'cute');
  assert.equal(safe.fallbackReason, 'preference_read_failed');
  assert.equal(health[0][0], 'conversation_style');
  assert.doesNotMatch(warnings.join('\n'), /123456789012345678/);
});

test('chat-style command uses the current display name and one global preference across guilds', async () => {
  await initializeCoinDatabase();
  const commandData = chatStyleCommand.data.toJSON();
  assert.equal(commandData.dm_permission, false);
  assert.deepEqual(
    commandData.options.find((option) => option.name === 'set').options[0].choices.map((choice) => choice.value),
    CHAT_STYLE_NAMES
  );
  const replies = [];
  function interaction(action, displayName, guildId, style = null) {
    return {
      guildId,
      user: { id: 'global-style-user', username: 'account-name', globalName: 'global-name' },
      member: { displayName },
      options: {
        getSubcommand: () => action,
        getString: () => style,
      },
      replied: false,
      deferred: false,
      async reply(payload) { replies.push(payload); },
    };
  }
  await chatStyleCommand.execute(interaction('set', '第一個暱稱', 'guild-a', 'ceo'));
  await chatStyleCommand.execute(interaction('current', '更新後暱稱', 'guild-b'));
  assert.match(replies[0].content, /第一個暱稱/);
  assert.match(replies[0].content, /霸總風/);
  assert.match(replies[1].content, /更新後暱稱/);
  assert.match(replies[1].content, /霸總風/);
  assert.ok(replies.every((reply) => reply.ephemeral === true));
  assert.doesNotMatch(JSON.stringify(replies), /global-style-user/);
});

test('romance v17 migration is additive, restart-idempotent, and preserves failures byte-for-byte', async () => {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  await initializeCoinDatabase();
  resetCoinDatabaseForTests();
  const priorV16 = new SQL.Database(fs.readFileSync(dbPath));
  stripV22TablesForLegacyFixture(priorV16);
  priorV16.exec(`
    DROP TABLE user_romance_preferences;
    DROP TRIGGER coin_players_v19_archive_no_insert;
    DROP TRIGGER coin_players_v19_archive_no_update;
    DROP TRIGGER coin_players_v19_archive_no_delete;
    DROP TABLE coin_guild_players;
    DROP TABLE coin_wallets;
    DROP TABLE coin_wallet_migrations;
    CREATE TABLE romance_migration_sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO romance_migration_sentinel (id, value) VALUES (1, 'preserve-v16');
    UPDATE coin_metadata SET value = '16' WHERE key = 'schema_version';
  `);
  fs.writeFileSync(dbPath, Buffer.from(priorV16.export()));
  priorV16.close();

  const info = await initializeCoinDatabase();
  const migrated = await withCoinDatabase((api) => ({
    version: api.get("SELECT value FROM coin_metadata WHERE key = 'schema_version'").value,
    sentinel: api.get('SELECT value FROM romance_migration_sentinel WHERE id = 1').value,
    columns: api.all('PRAGMA table_info(user_romance_preferences)').map((column) => column.name),
    definition: api.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_romance_preferences'").sql,
  }));
  assert.equal(info.schemaVersion, 22);
  assert.equal(migrated.version, '22');
  assert.equal(migrated.sentinel, 'preserve-v16');
  assert.deepEqual(migrated.columns, ['user_id', 'enabled', 'started_at', 'updated_at']);
  assert.match(migrated.definition, /CHECK \(enabled IN \(0, 1\)\)/);

  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  assert.equal(Number(await withCoinDatabase((api) => api.get(
    'SELECT COUNT(*) AS count FROM romance_migration_sentinel'
  ).count)), 1);

  for (const fixtureCase of [
    {
      version: '16',
      extra: 'CREATE TABLE user_romance_preferences (user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL);',
      message: /v20 結構驗證失敗/,
    },
    { version: '23', extra: '', message: /不支援/ },
  ]) {
    resetCoinDatabaseForTests();
    fs.rmSync(dbPath, { force: true });
    const fixture = new SQL.Database();
    fixture.exec(`
      CREATE TABLE coin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', '${fixtureCase.version}', '2026-01-01T00:00:00.000Z');
      ${fixtureCase.extra}
    `);
    const originalBytes = Buffer.from(fixture.export());
    fs.writeFileSync(dbPath, originalBytes);
    fixture.close();
    await assert.rejects(() => initializeCoinDatabase(), fixtureCase.message);
    assert.deepEqual(fs.readFileSync(dbPath), originalBytes);
  }
});

test('romance preferences default off, persist globally, isolate users, and serialize last write', async () => {
  await initializeCoinDatabase();
  const initial = await getUserRomancePreference('romance-user');
  assert.equal(initial.enabled, false);
  assert.equal(initial.persisted, false);

  const started = await setUserRomancePreference('romance-user', true, {
    now: new Date('2026-09-03T03:00:00.000Z'),
  });
  assert.equal(started.enabled, true);
  assert.equal(started.startedAt, '2026-09-03T03:00:00.000Z');
  assert.equal((await getUserRomancePreference('different-romance-user')).enabled, false);

  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  assert.equal((await getUserRomancePreference('romance-user')).enabled, true);

  await Promise.all([
    setUserRomancePreference('romance-user', true, { now: new Date('2026-09-03T04:00:00.000Z') }),
    setUserRomancePreference('romance-user', false, { now: new Date('2026-09-03T04:00:01.000Z') }),
  ]);
  const stopped = await getUserRomancePreference('romance-user');
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.startedAt, '2026-09-03T03:00:00.000Z');
  assert.deepEqual(
    await withCoinDatabase((api) => api.all('PRAGMA table_info(user_romance_preferences)').map((column) => column.name)),
    ['user_id', 'enabled', 'started_at', 'updated_at']
  );
});

test('romance malformed data and read failure fail safe off without exposing an identifier', async () => {
  await initializeCoinDatabase();
  await withCoinTransaction((api) => {
    api.run('PRAGMA ignore_check_constraints = ON');
    api.run(
      'INSERT INTO user_romance_preferences (user_id, enabled, started_at, updated_at) VALUES (?, ?, ?, ?)',
      ['malformed-romance-user', 2, null, '2026-09-03T00:00:00.000Z']
    );
    api.run('PRAGMA ignore_check_constraints = OFF');
  });
  const malformed = await getUserRomancePreference('malformed-romance-user');
  assert.equal(malformed.enabled, false);
  assert.equal(malformed.malformed, true);

  const warnings = [];
  const health = [];
  const safe = await resolveUserRomancePreference('123456789012345678', {
    reader: async () => { throw new Error('synthetic database failure'); },
    healthReporter: async (...args) => { health.push(args); },
    loggerImpl: { warn: (message) => warnings.push(message) },
  });
  assert.equal(safe.enabled, false);
  assert.equal(safe.fallbackReason, 'preference_read_failed');
  assert.equal(health[0][0], 'romance_mode');
  assert.doesNotMatch(warnings.join('\n'), /123456789012345678/);
});

test('romance command uses current display name and global start/status/stop state', async () => {
  await initializeCoinDatabase();
  const commandData = romanceCommand.data.toJSON();
  assert.equal(commandData.dm_permission, false);
  assert.deepEqual(commandData.options.map((option) => option.name), ['start', 'stop', 'status']);
  const replies = [];
  function interaction(action, displayName, guildId) {
    return {
      guildId,
      user: { id: 'global-romance-user', username: 'account-name', globalName: 'global-name' },
      member: { displayName },
      options: { getSubcommand: () => action },
      replied: false,
      deferred: false,
      async reply(payload) { replies.push(payload); },
    };
  }
  await romanceCommand.execute(interaction('start', '第一個暱稱', 'guild-a'));
  await romanceCommand.execute(interaction('status', '更新後暱稱', 'guild-b'));
  await romanceCommand.execute(interaction('stop', '最後暱稱', 'guild-c'));
  await romanceCommand.execute(interaction('status', '最後暱稱', 'guild-a'));
  assert.match(replies[0].content, /第一個暱稱.*已開啟/);
  assert.match(replies[1].content, /更新後暱稱.*已開啟/);
  assert.match(replies[2].content, /最後暱稱.*立即關閉/);
  assert.match(replies[3].content, /最後暱稱.*已關閉/);
  assert.ok(replies.every((reply) => reply.ephemeral === true));
  assert.doesNotMatch(JSON.stringify(replies), /global-romance-user/);
});

test('cross-guild mention memory and weather fast paths preserve global style and romance preferences', async () => {
  await initializeCoinDatabase();
  clearMemoryForTests();
  clearConversationStateForTests();

  const userId = '123456789012345678';
  const botId = '999999999999999999';
  await setUserChatPreference(userId, 'tsundere');
  await setUserRomancePreference(userId, true);

  async function invoke(guildId, channelId, content) {
    const replies = [];
    const channelMessages = [];
    const message = {
      content: `<@${botId}> ${content}`,
      guildId,
      channelId,
      author: {
        id: userId,
        bot: false,
        tag: 'traveller#0001',
        username: 'traveller',
        globalName: '跨服旅人',
      },
      member: { displayName: '跨服旅人' },
      client: { user: { id: botId } },
      channel: {
        messages: {},
        async send(payload) { channelMessages.push(payload); },
      },
      async reply(payload) { replies.push(payload); },
    };

    await handleMentionMessage(message);
    return { replies, channelMessages };
  }

  const memory = await invoke('preference-origin-guild-b', 'memory-channel', '我剛剛有沒有說晚安？');
  const weather = await invoke('preference-origin-guild-c', 'weather-channel', '東區天氣');

  for (const result of [memory, weather]) {
    assert.equal(result.replies.length, 1);
    assert.deepEqual(result.channelMessages, []);
    assert.match(result.replies[0].content, /跨服旅人/);
    assert.match(result.replies[0].content, /才沒有特別期待你來/);
    assert.match(result.replies[0].content, /才不是特地整理/);
    assert.match(result.replies[0].content, /小吉/);
    assert.doesNotMatch(result.replies[0].content, new RegExp(userId));
  }
  assert.match(memory.replies[0].content, /目前沒有在可查的公開紀錄中找到/);
  assert.match(weather.replies[0].content, /這個地名有點模糊/);

  clearConversationStateForTests();
  clearMemoryForTests();
});

test('word-chain validator normalizes input and rejects invalid length, characters, and unknown words', () => {
  assert.deepEqual(validateWord('  安心  '), { ok: true, word: '安心', graphemes: ['安', '心'] });
  assert.equal(validateWord('一二三四五六七').code, 'INVALID_LENGTH');
  assert.equal(validateWord('安1心').code, 'INVALID_CHARACTERS');
  assert.equal(validateWord('火星語').code, 'UNKNOWN_WORD');
});

test('word-chain corpus graph has deterministic successors and explicitly terminal words', () => {
  assert.doesNotThrow(() => assertCorpusInvariant());
  assert.ok(words.length >= 150);
  for (const word of words) {
    for (const successor of getSuccessors(word)) {
      assert.equal(successor[0], word.at(-1));
    }
  }
  assert.deepEqual(getSuccessors('白雲'), []);
  assert.ok(getSuccessors('明白').includes('白雲'));
});

test('word-chain accepts only valid alternating entries and de-duplicates Discord delivery', async () => {
  await startWordChain({ guildId: 'guild-word', channelId: 'channel-word', actorId: 'admin-word', seed: '不安' });

  const accepted = await acceptWordChainMessage({
    guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-1', userId: 'user-a', content: '安心',
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.completed, false);
  assert.equal(accepted.session.currentWord, '安心');
  assert.equal(accepted.session.revision, 1);

  const duplicate = await acceptWordChainMessage({
    guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-1', userId: 'user-a', content: '安心',
  });
  assert.deepEqual(duplicate, { ok: true, duplicate: true, sessionId: accepted.session.id });

  const sameUser = await acceptWordChainMessage({
    guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-2', userId: 'user-a', content: '心情',
  });
  assert.equal(sameUser.code, 'SAME_USER');

  await acceptWordChainMessage({ guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-3', userId: 'user-b', content: '心意' });
  await acceptWordChainMessage({ guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-4', userId: 'user-c', content: '意見' });
  await acceptWordChainMessage({ guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-5', userId: 'user-a', content: '見面' });
  await acceptWordChainMessage({ guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-6', userId: 'user-b', content: '面前' });
  await acceptWordChainMessage({ guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-7', userId: 'user-c', content: '前面' });

  const repeated = await acceptWordChainMessage({
    guildId: 'guild-word', channelId: 'channel-word', expectedChannelId: 'channel-word', messageId: 'message-8', userId: 'user-a', content: '面前',
  });
  assert.equal(repeated.code, 'REPEATED_WORD');

  const wrongChannel = await acceptWordChainMessage({
    guildId: 'guild-word', channelId: 'channel-other', expectedChannelId: 'channel-word', messageId: 'message-9', userId: 'user-b', content: '哥哥',
  });
  assert.equal(wrongChannel.code, 'WRONG_CHANNEL');
  assert.equal((await getWordChainStatus('guild-word', 'channel-word')).revision, 6);
  assert.equal((await stopWordChain({ guildId: 'guild-word', channelId: 'channel-word', actorId: 'admin-word' })).stopped, true);
});

test('word-chain reaction delivery confirms accepted messages and retries a bounded outbox reaction', async () => {
  await startWordChain({ guildId: 'guild-react', channelId: 'channel-react', actorId: 'admin-react', seed: '不安' });
  const replies = [];
  const acceptedMessage = {
    id: 'reaction-ok', guildId: 'guild-react', channelId: 'channel-react', content: '安心', author: { id: 'user-a' },
    react: async (emoji) => { assert.equal(emoji, REACTION_EMOJI); }, reply: async (payload) => replies.push(payload),
  };
  assert.equal(await handleWordChainMessage(acceptedMessage, { channelId: 'channel-react' }), true);
  assert.deepEqual(replies, []);

  await stopWordChain({ guildId: 'guild-react', channelId: 'channel-react', actorId: 'admin-react' });
  await startWordChain({ guildId: 'guild-react', channelId: 'channel-react', actorId: 'admin-react', seed: '不安' });

  const failedMessage = {
    id: 'reaction-retry', guildId: 'guild-react', channelId: 'channel-react', content: '安心', author: { id: 'user-b' },
    react: async () => { throw new Error('missing reaction permission'); }, reply: async (payload) => replies.push(payload),
  };
  assert.equal(await handleWordChainMessage(failedMessage, { channelId: 'channel-react' }), true);
  const beforeRetry = await withCoinDatabase((api) => api.get("SELECT status, payload_json FROM feature_outbox WHERE dedupe_key = 'reaction:reaction-retry'"));
  assert.equal(beforeRetry.status, 'pending');
  assert.doesNotMatch(beforeRetry.payload_json, /哥哥/);

  const retryChannel = {
    messages: { fetch: async () => ({ react: async () => { throw new Error('temporary Discord failure'); } }) },
  };
  const retryGuild = { channels: { cache: new Map([['channel-react', retryChannel]]) } };
  const retryClient = { guilds: { cache: new Map([['guild-react', retryGuild]]) } };
  const firstAttempt = await processWordChainReactionOutbox(retryClient, { workerId: 'test-word-retry' });
  assert.deepEqual(firstAttempt, { claimed: 1, delivered: 0, retried: 1 });
  const afterFailure = await withCoinDatabase((api) => api.get("SELECT status, attempt_count FROM feature_outbox WHERE dedupe_key = 'reaction:reaction-retry'"));
  assert.equal(afterFailure.status, 'pending');
  assert.equal(Number(afterFailure.attempt_count), 1);

  await withCoinTransaction((api) => api.run("UPDATE feature_outbox SET available_at = '2000-01-01T00:00:00.000Z' WHERE dedupe_key = 'reaction:reaction-retry'"));
  let reacted = false;
  const successChannel = {
    messages: { fetch: async () => ({ react: async (emoji) => { reacted = emoji === REACTION_EMOJI; } }) },
  };
  const successGuild = { channels: { cache: new Map([['channel-react', successChannel]]) } };
  const successClient = { guilds: { cache: new Map([['guild-react', successGuild]]) } };
  const secondAttempt = await processWordChainReactionOutbox(successClient, { workerId: 'test-word-retry-two' });
  assert.deepEqual(secondAttempt, { claimed: 1, delivered: 1, retried: 0 });
  assert.equal(reacted, true);
});

test('terminal word completes the session atomically and tells players how to start another round', async () => {
  await startWordChain({ guildId: 'guild-terminal', channelId: 'channel-terminal', actorId: 'admin-terminal' });
  const replies = [];
  const message = {
    id: 'terminal-message', guildId: 'guild-terminal', channelId: 'channel-terminal', content: '白雲', author: { id: 'user-terminal' },
    react: async (emoji) => assert.equal(emoji, REACTION_EMOJI), reply: async (payload) => replies.push(payload),
  };
  await handleWordChainMessage(message, { channelId: 'channel-terminal' });
  const session = await withCoinDatabase((api) => api.get('SELECT status, completed_at FROM text_chain_sessions WHERE guild_id = ?', ['guild-terminal']));
  assert.equal(session.status, 'completed');
  assert.ok(session.completed_at);
  assert.equal(await getWordChainStatus('guild-terminal', 'channel-terminal'), null);
  assert.match(replies[0].content, /完成/);
  assert.match(replies[0].content, /\/word-chain start/);
  assert.equal((await getGuildFeatureSetting('guild-terminal', 'word_chain')).enabled, false);
});

test('word-chain start switches the only active guild session and feature setting in one transaction', async () => {
  await startWordChain({ guildId: 'guild-switch', channelId: 'channel-a', actorId: 'admin-switch', seed: '不安' });
  const switched = await startWordChain({ guildId: 'guild-switch', channelId: 'channel-b', actorId: 'admin-switch', seed: '明白' });
  assert.equal(switched.alreadyActive, false);
  assert.equal(switched.stoppedSession.status, 'stopped');
  const state = await withCoinDatabase((api) => ({
    sessions: api.all('SELECT channel_id, status FROM text_chain_sessions WHERE guild_id = ? ORDER BY id', ['guild-switch']),
  }));
  assert.deepEqual(state.sessions, [
    { channel_id: 'channel-a', status: 'stopped' },
    { channel_id: 'channel-b', status: 'active' },
  ]);
  assert.deepEqual(
    { enabled: (await getGuildFeatureSetting('guild-switch', 'word_chain')).enabled, channelId: (await getGuildFeatureSetting('guild-switch', 'word_chain')).channelId },
    { enabled: true, channelId: 'channel-b' }
  );
  assert.equal((await stopWordChain({ guildId: 'guild-switch', channelId: 'channel-b', actorId: 'admin-switch' })).stopped, true);
  assert.equal((await getGuildFeatureSetting('guild-switch', 'word_chain')).enabled, false);
});

test('word-chain start rolls back session switch and feature setting when its transaction fails', async () => {
  await startWordChain({ guildId: 'guild-rollback', channelId: 'channel-a', actorId: 'admin-rollback', seed: '不安' });
  await assert.rejects(
    () => startWordChain({
      guildId: 'guild-rollback', channelId: 'channel-b', actorId: 'admin-rollback', seed: '明白',
      beforeCommit: () => { throw new Error('synthetic persistence failure'); },
    }),
    /synthetic persistence failure/
  );
  assert.equal((await getWordChainStatus('guild-rollback', 'channel-a')).status, 'active');
  assert.equal(await getWordChainStatus('guild-rollback', 'channel-b'), null);
  const setting = await getGuildFeatureSetting('guild-rollback', 'word_chain');
  assert.deepEqual({ enabled: setting.enabled, channelId: setting.channelId }, { enabled: true, channelId: 'channel-a' });
});

test('word-chain outbox dead-letters permanent Discord errors and bounded retry exhaustion', async () => {
  const queue = async (dedupeKey, channelId = 'channel-dead') => enqueueFeatureOutbox({
    guildId: 'guild-dead', featureKey: 'word_chain', eventType: 'discord_reaction', dedupeKey,
    payload: buildReactionPayload({ guildId: 'guild-dead', channelId, messageId: dedupeKey }),
  });
  await queue('permanent');
  const permanentChannel = {
    messages: { fetch: async () => ({ react: async () => { const error = new Error('missing permissions'); error.code = 50013; throw error; } }) },
  };
  const permanentGuild = {
    channels: {
      cache: new Map([['channel-dead', permanentChannel]]),
      fetch: async () => { const error = new Error('unknown channel'); error.code = 10003; throw error; },
    },
  };
  const permanentClient = { guilds: { cache: new Map([['guild-dead', permanentGuild]]) } };
  await processWordChainReactionOutbox(permanentClient, { workerId: 'dead-permanent' });
  const permanent = await withCoinDatabase((api) => ({
    outbox: api.get("SELECT id FROM feature_outbox WHERE dedupe_key = 'permanent'"),
    dead: api.get("SELECT dead_letter_reason FROM feature_outbox_dead_letters WHERE dedupe_key = 'permanent'"),
    health: api.get("SELECT status FROM feature_health WHERE feature_key = 'word_chain'"),
  }));
  assert.equal(permanent.outbox, null);
  assert.equal(permanent.dead.dead_letter_reason, 'discord_permanent_50013');
  assert.equal(permanent.health.status, 'broken');

  await queue('deleted-channel', 'channel-deleted');
  await processWordChainReactionOutbox(permanentClient, { workerId: 'dead-deleted-channel' });
  assert.equal(
    (await withCoinDatabase((api) => api.get("SELECT dead_letter_reason FROM feature_outbox_dead_letters WHERE dedupe_key = 'deleted-channel'"))).dead_letter_reason,
    'discord_permanent_10003'
  );

  await queue('max-attempts');
  await withCoinTransaction((api) => api.run("UPDATE feature_outbox SET attempt_count = 4 WHERE dedupe_key = 'max-attempts'"));
  const temporaryChannel = { messages: { fetch: async () => ({ react: async () => { throw new Error('temporary'); } }) } };
  const temporaryGuild = { channels: { cache: new Map([['channel-dead', temporaryChannel]]) } };
  const temporaryClient = { guilds: { cache: new Map([['guild-dead', temporaryGuild]]) } };
  await processWordChainReactionOutbox(temporaryClient, { workerId: 'dead-max' });
  assert.equal(
    (await withCoinDatabase((api) => api.get("SELECT dead_letter_reason FROM feature_outbox_dead_letters WHERE dedupe_key = 'max-attempts'"))).dead_letter_reason,
    'max_attempts'
  );
});

test('word-chain outbox does not report delivery or retry after a lost lease and bounds reaction payloads', async () => {
  const event = {
    id: 99, guildId: 'guild-lease', featureKey: 'word_chain', eventType: 'discord_reaction', attemptCount: 1,
    payload: buildReactionPayload({ guildId: 'guild-lease', channelId: 'channel-lease', messageId: 'message-lease' }),
  };
  const leaseChannel = { messages: { fetch: async () => ({ react: async () => {} }) } };
  const leaseGuild = { channels: { cache: new Map([['channel-lease', leaseChannel]]) } };
  const client = { guilds: { cache: new Map([['guild-lease', leaseGuild]]) } };
  const lostDelivery = await processWordChainReactionOutbox(client, {
    workerId: 'lost-delivery', claim: async () => [event], markDelivered: async () => ({ updated: false }), retry: async () => { throw new Error('must not retry'); },
  });
  assert.deepEqual(lostDelivery, { claimed: 1, delivered: 0, retried: 0 });
  const lostFailure = await processWordChainReactionOutbox({ guilds: { cache: new Map() } }, {
    workerId: 'lost-failure', claim: async () => [{ ...event, id: 100 }], retry: async () => ({ updated: false }), deadLetter: async () => ({ updated: false }),
  });
  assert.deepEqual(lostFailure, { claimed: 1, delivered: 0, retried: 0 });
  assert.throws(
    () => buildReactionPayload({ guildId: 'g'.repeat(81), channelId: 'channel', messageId: 'message' }),
    /guildId is required/
  );
});

test('message feature router gives word chain first chance and message event keeps it between extension hooks and mention/memory', async () => {
  const order = [];
  const router = createMessageFeatureRouter({
    handlers: {
      word_chain: async () => { order.push('word_chain'); return true; },
      number_chain: async () => { order.push('number_chain'); return true; },
    },
    loadSetting: async () => ({ enabled: true, channelId: 'channel-router' }),
  });
  assert.equal((await router({ guildId: 'guild-router', channelId: 'channel-router', author: { bot: false } })).featureKey, 'word_chain');
  assert.deepEqual(order, ['word_chain']);

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'events', 'messageCreate.js'), 'utf8');
  assert.ok(source.indexOf("'messageCreate'") < source.indexOf('await routeMessageFeatures'));
  assert.ok(source.indexOf('await routeMessageFeatures') < source.indexOf('await handleMentionMessage'));
  assert.ok(source.indexOf('await routeMessageFeatures') < source.indexOf('recordPublicMessage(message)'));
});

test('chain starts reject only same-channel cross-feature conflicts and preserve both settings atomically', async () => {
  await startWordChain({ guildId: 'guild-chain-conflict-word', channelId: 'shared-channel', actorId: 'admin-word', seed: '不安' });
  await assert.rejects(
    () => startNumberChain({ guildId: 'guild-chain-conflict-word', channelId: 'shared-channel', actorId: 'admin-number', target: 15 }),
    (error) => error?.code === 'CHAIN_CHANNEL_CONFLICT' && /文字接龍/.test(error.message)
  );
  assert.equal((await getWordChainStatus('guild-chain-conflict-word', 'shared-channel')).status, 'active');
  assert.equal(await getNumberChainStatus('guild-chain-conflict-word', 'shared-channel'), null);
  assert.deepEqual(
    await withCoinDatabase((api) => api.all("SELECT feature_key, enabled, channel_id FROM feature_guild_settings WHERE guild_id = ? ORDER BY feature_key", ['guild-chain-conflict-word'])),
    [{ feature_key: 'word_chain', enabled: 1, channel_id: 'shared-channel' }]
  );

  await startNumberChain({ guildId: 'guild-chain-conflict-number', channelId: 'shared-channel', actorId: 'admin-number', target: 15 });
  await assert.rejects(
    () => startWordChain({ guildId: 'guild-chain-conflict-number', channelId: 'shared-channel', actorId: 'admin-word', seed: '不安' }),
    (error) => error?.code === 'CHAIN_CHANNEL_CONFLICT' && /數字接龍/.test(error.message)
  );
  assert.equal((await getNumberChainStatus('guild-chain-conflict-number', 'shared-channel')).status, 'active');
  assert.equal(await getWordChainStatus('guild-chain-conflict-number', 'shared-channel'), null);
  assert.deepEqual(
    await withCoinDatabase((api) => api.all("SELECT feature_key, enabled, channel_id FROM feature_guild_settings WHERE guild_id = ? ORDER BY feature_key", ['guild-chain-conflict-number'])),
    [{ feature_key: 'number_chain', enabled: 1, channel_id: 'shared-channel' }]
  );

  await startWordChain({ guildId: 'guild-chain-parallel', channelId: 'word-channel', actorId: 'admin-word', seed: '不安' });
  await startNumberChain({ guildId: 'guild-chain-parallel', channelId: 'number-channel', actorId: 'admin-number', target: 15 });
  const reactions = [];
  const wordRoute = await routeMessageFeatures({
    id: 'parallel-word-message', guildId: 'guild-chain-parallel', channelId: 'word-channel', content: '安心', author: { id: 'word-player', bot: false },
    react: async (emoji) => reactions.push(`word:${emoji}`), reply: async () => { throw new Error('word should be accepted'); },
  });
  const numberRoute = await routeMessageFeatures({
    id: 'parallel-number-message', guildId: 'guild-chain-parallel', channelId: 'number-channel', content: '3*5', author: { id: 'number-player', bot: false },
    react: async (emoji) => reactions.push(`number:${emoji}`), reply: async () => { throw new Error('number should be accepted'); },
  });
  assert.deepEqual(wordRoute, { handled: true, featureKey: 'word_chain' });
  assert.deepEqual(numberRoute, { handled: true, featureKey: 'number_chain' });
  assert.deepEqual(reactions, [`word:${REACTION_EMOJI}`, `number:${REACTION_EMOJI}`]);

  const wordCommandSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'word-chain.js'), 'utf8');
  const numberCommandSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'number-chain.js'), 'utf8');
  assert.match(wordCommandSource, /CHAIN_CHANNEL_CONFLICT/);
  assert.match(wordCommandSource, /已有進行中的數字接龍/);
  assert.match(numberCommandSource, /CHAIN_CHANNEL_CONFLICT/);
  assert.match(numberCommandSource, /已有進行中的文字接龍/);
});

test('number-chain parser evaluates bounded exact arithmetic without JavaScript evaluation', () => {
  for (const [expression, expected] of [
    ['15', '15'],
    ['3*5', '15'],
    ['5*3', '15'],
    ['4+11', '15'],
    ['2+3*4', '14'],
    ['(2+3)*4', '20'],
    ['-(-15)', '15'],
    ['15/3', '5'],
    ['(6/3)+(2*4)', '10'],
  ]) {
    const result = evaluateNumberExpression(expression);
    assert.equal(result.ok, true, expression);
    assert.equal(result.result, expected, expression);
  }
  for (const [expression, code] of [
    ['1/3', 'NON_INTEGER_RESULT'],
    ['1/0', 'DIVISION_BY_ZERO'],
    ['alert(1)', 'INVALID_TOKEN'],
    ['2**3', 'INVALID_SYNTAX'],
    ['2(3)', 'IMPLICIT_MULTIPLICATION'],
    ['1e3', 'DECIMAL_OR_EXPONENT'],
    ['1.5', 'DECIMAL_OR_EXPONENT'],
    ['9'.repeat(MAX_INPUT_LENGTH + 1), 'INPUT_LENGTH'],
    ['1234567890123456789', 'INTEGER_LIMIT'],
    [`${'('.repeat(9)}1${')'.repeat(9)}`, 'PARENTHESIS_DEPTH'],
    ['999999999999999999*999999999999999999*999999999999999999', 'INTERMEDIATE_LIMIT'],
  ]) {
    const result = evaluateNumberExpression(expression);
    assert.equal(result.ok, false, expression);
    assert.equal(result.code, code, expression);
  }
  const parserSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'numberExpressionService.js'), 'utf8');
  assert.doesNotMatch(parserSource, /\beval\s*\(/);
  assert.doesNotMatch(parserSource, /\bFunction\s*\(/);
});

test('number-chain validates matching exact results, alternating players, channel binding, and duplicate delivery', async () => {
  await startNumberChain({ guildId: 'guild-number', channelId: 'channel-number', actorId: 'admin-number', target: 15 });
  const accepted = await acceptNumberChainMessage({
    guildId: 'guild-number', channelId: 'channel-number', expectedChannelId: 'channel-number',
    messageId: 'number-message-1', userId: 'number-user-a', content: '3*5',
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.session.expectedTarget, 16);
  const duplicate = await acceptNumberChainMessage({
    guildId: 'guild-number', channelId: 'channel-number', expectedChannelId: 'channel-number',
    messageId: 'number-message-1', userId: 'number-user-b', content: '5*3',
  });
  assert.deepEqual(duplicate, { ok: true, duplicate: true, sessionId: accepted.session.id });
  const sameUser = await acceptNumberChainMessage({
    guildId: 'guild-number', channelId: 'channel-number', expectedChannelId: 'channel-number',
    messageId: 'number-message-2', userId: 'number-user-a', content: '4*4',
  });
  assert.equal(sameUser.code, 'SAME_USER');
  const mismatch = await acceptNumberChainMessage({
    guildId: 'guild-number', channelId: 'channel-number', expectedChannelId: 'channel-number',
    messageId: 'number-message-3', userId: 'number-user-b', content: '4+11',
  });
  assert.equal(mismatch.code, 'TARGET_MISMATCH');
  const wrongChannel = await acceptNumberChainMessage({
    guildId: 'guild-number', channelId: 'other-channel', expectedChannelId: 'channel-number',
    messageId: 'number-message-4', userId: 'number-user-b', content: '16',
  });
  assert.equal(wrongChannel.code, 'WRONG_CHANNEL');
  const next = await acceptNumberChainMessage({
    guildId: 'guild-number', channelId: 'channel-number', expectedChannelId: 'channel-number',
    messageId: 'number-message-5', userId: 'number-user-b', content: '4*4',
  });
  assert.equal(next.ok, true);
  assert.equal((await getNumberChainStatus('guild-number', 'channel-number')).expectedTarget, 17);

  await startNumberChain({ guildId: 'guild-number-race', channelId: 'channel-number-race', actorId: 'admin-number', target: 15 });
  const raceInput = {
    guildId: 'guild-number-race', channelId: 'channel-number-race', expectedChannelId: 'channel-number-race',
    messageId: 'number-race-message', userId: 'number-race-user', content: '5*3',
  };
  const race = await Promise.all([acceptNumberChainMessage(raceInput), acceptNumberChainMessage(raceInput)]);
  assert.equal(race.filter((result) => result.ok && !result.duplicate).length, 1);
  assert.equal(race.filter((result) => result.duplicate).length, 1);
  assert.equal((await getNumberChainStatus('guild-number-race', 'channel-number-race')).expectedTarget, 16);
});

test('number-chain start switches the active channel atomically, stops it, and rolls back a failed switch', async () => {
  await startNumberChain({ guildId: 'guild-number-switch', channelId: 'number-a', actorId: 'admin-number', target: 15 });
  const switched = await startNumberChain({ guildId: 'guild-number-switch', channelId: 'number-b', actorId: 'admin-number', target: 20 });
  assert.equal(switched.stoppedSession.status, 'stopped');
  assert.deepEqual(
    await withCoinDatabase((api) => api.all('SELECT channel_id, status FROM number_chain_sessions WHERE guild_id = ? ORDER BY id', ['guild-number-switch'])),
    [{ channel_id: 'number-a', status: 'stopped' }, { channel_id: 'number-b', status: 'active' }]
  );
  assert.deepEqual(
    { enabled: (await getGuildFeatureSetting('guild-number-switch', 'number_chain')).enabled, channelId: (await getGuildFeatureSetting('guild-number-switch', 'number_chain')).channelId },
    { enabled: true, channelId: 'number-b' }
  );
  assert.equal((await stopNumberChain({ guildId: 'guild-number-switch', channelId: 'number-b', actorId: 'admin-number' })).stopped, true);
  assert.equal((await getGuildFeatureSetting('guild-number-switch', 'number_chain')).enabled, false);

  await startNumberChain({ guildId: 'guild-number-rollback', channelId: 'number-a', actorId: 'admin-number', target: 1 });
  await assert.rejects(
    () => startNumberChain({
      guildId: 'guild-number-rollback', channelId: 'number-b', actorId: 'admin-number', target: 2,
      beforeCommit: () => { throw new Error('synthetic number persistence failure'); },
    }),
    /synthetic number persistence failure/
  );
  assert.equal((await getNumberChainStatus('guild-number-rollback', 'number-a')).status, 'active');
  assert.equal(await getNumberChainStatus('guild-number-rollback', 'number-b'), null);
  assert.deepEqual(
    { enabled: (await getGuildFeatureSetting('guild-number-rollback', 'number_chain')).enabled, channelId: (await getGuildFeatureSetting('guild-number-rollback', 'number_chain')).channelId },
    { enabled: true, channelId: 'number-a' }
  );
});

test('number-chain accepts a Discord reaction failure into the shared bounded reaction outbox', async () => {
  await startNumberChain({ guildId: 'guild-number-react', channelId: 'channel-number-react', actorId: 'admin-number', target: 15 });
  const replies = [];
  const message = {
    id: 'number-reaction-retry', guildId: 'guild-number-react', channelId: 'channel-number-react', content: '4+11', author: { id: 'number-user-a' },
    react: async () => { throw new Error('temporary reaction failure'); }, reply: async (payload) => replies.push(payload),
  };
  assert.equal(await handleNumberChainMessage(message, { channelId: 'channel-number-react' }), true);
  assert.deepEqual(replies, []);
  const queued = await withCoinDatabase((api) => api.get("SELECT feature_key, status, payload_json FROM feature_outbox WHERE dedupe_key = 'reaction:number-reaction-retry'"));
  assert.equal(queued.feature_key, 'number_chain');
  assert.equal(queued.status, 'pending');
  assert.doesNotMatch(queued.payload_json, /4\+11/);
  let reacted = false;
  const client = {
    guilds: {
      cache: new Map([['guild-number-react', {
        channels: { cache: new Map([['channel-number-react', { messages: { fetch: async () => ({ react: async (emoji) => { reacted = emoji === REACTION_EMOJI; } }) } }]]) },
      }]]),
    },
  };
  const processed = await processWordChainReactionOutbox(client, { workerId: 'number-retry-worker' });
  assert.deepEqual(processed, { claimed: 1, delivered: 1, retried: 0 });
  assert.equal(reacted, true);
});

test('feature rewards are atomic and idempotent across concurrent calls and restart', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 12 }, () =>
      grantRewardOnce('guild-foundation', 'user-foundation', 'daily_riddle', '2026-09-03', 'participation', 30, {
        synthetic: true,
      })
    )
  );

  assert.equal(attempts.filter((result) => !result.alreadyGranted).length, 1);
  assert.equal(attempts.filter((result) => result.alreadyGranted).length, 11);

  const beforeRestart = await withCoinTransaction((api) => ({
    player: api.get('SELECT balance, total_earned FROM coin_wallets WHERE user_id = ?', ['user-foundation']),
    grants: api.get('SELECT COUNT(*) AS count FROM reward_grants').count,
    transactions: api.get("SELECT COUNT(*) AS count FROM coin_transactions WHERE type = 'system_reward'").count,
    integrity: api.get('PRAGMA integrity_check').integrity_check,
  }));

  assert.equal(Number(beforeRestart.player.balance), 30);
  assert.equal(Number(beforeRestart.player.total_earned), 30);
  assert.equal(Number(beforeRestart.grants), 1);
  assert.equal(Number(beforeRestart.transactions), 1);
  assert.equal(beforeRestart.integrity, 'ok');

  resetCoinDatabaseForTests();
  const duplicate = await grantRewardOnce(
    'guild-foundation',
    'user-foundation',
    'daily_riddle',
    '2026-09-03',
    'participation',
    30,
    { synthetic: true }
  );

  assert.equal(duplicate.alreadyGranted, true);
  assert.equal(duplicate.balance, 30);
  assert.equal(duplicate.totalEarned, 30);
});

test('feature rewards reject disabled guild economies before creating grants, players, or transactions', async () => {
  await withCoinTransaction((api) => {
    api.run(
      `INSERT INTO coin_guild_settings (guild_id, enabled, created_at, updated_at)
       VALUES (?, 0, ?, ?)`,
      ['guild-disabled', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z']
    );
  });

  await assert.rejects(
    () => grantRewardOnce('guild-disabled', 'user-disabled', 'daily_riddle', '2026-09-03', 'participation', 30),
    (error) => error.code === 'COIN_DISABLED'
  );

  const counts = await withCoinTransaction((api) => ({
    players: api.get("SELECT COUNT(*) AS count FROM coin_guild_players WHERE guild_id = 'guild-disabled'").count,
    grants: api.get("SELECT COUNT(*) AS count FROM reward_grants WHERE guild_id = 'guild-disabled'").count,
    transactions: api.get("SELECT COUNT(*) AS count FROM coin_transactions WHERE guild_id = 'guild-disabled'").count,
  }));

  assert.deepEqual(Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])), {
    players: 0,
    grants: 0,
    transactions: 0,
  });
});

test('feature reward retries preserve existing grants after the guild economy is disabled', async () => {
  const first = await grantRewardOnce(
    'guild-retry-disabled',
    'user-retry-disabled',
    'daily_riddle',
    '2026-09-03',
    'participation',
    30
  );
  await withCoinTransaction((api) => {
    api.run('UPDATE coin_guild_settings SET enabled = 0 WHERE guild_id = ?', ['guild-retry-disabled']);
  });
  const beforeRetry = await withCoinTransaction((api) => ({
    player: api.get('SELECT balance, total_earned FROM coin_wallets WHERE user_id = ?', ['user-retry-disabled']),
    grants: api.get("SELECT COUNT(*) AS count FROM reward_grants WHERE guild_id = 'guild-retry-disabled'").count,
    transactions: api.get("SELECT COUNT(*) AS count FROM coin_transactions WHERE guild_id = 'guild-retry-disabled'").count,
  }));

  const retry = await grantRewardOnce(
    'guild-retry-disabled',
    'user-retry-disabled',
    'daily_riddle',
    '2026-09-03',
    'participation',
    30
  );
  const afterRetry = await withCoinTransaction((api) => ({
    player: api.get('SELECT balance, total_earned FROM coin_wallets WHERE user_id = ?', ['user-retry-disabled']),
    grants: api.get("SELECT COUNT(*) AS count FROM reward_grants WHERE guild_id = 'guild-retry-disabled'").count,
    transactions: api.get("SELECT COUNT(*) AS count FROM coin_transactions WHERE guild_id = 'guild-retry-disabled'").count,
  }));

  assert.equal(first.alreadyGranted, false);
  assert.equal(retry.alreadyGranted, true);
  assert.equal(retry.grant.id, first.grant.id);
  assert.equal(retry.balance, 30);
  assert.equal(retry.totalEarned, 30);
  assert.deepEqual(afterRetry, beforeRetry);
});

test('feature rewards roll back grants when safe balance or total-earned limits would overflow', async () => {
  const timestamp = '2026-09-03T00:00:00.000Z';
  await withCoinTransaction((api) => {
    api.run(
      `INSERT INTO coin_wallets (user_id, balance, total_earned, total_spent, revision, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)`,
      ['balance-limit', Number.MAX_SAFE_INTEGER, 0, timestamp, timestamp]
    );
    api.run(
      `INSERT INTO coin_wallets (user_id, balance, total_earned, total_spent, revision, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)`,
      ['earned-limit', 0, Number.MAX_SAFE_INTEGER, timestamp, timestamp]
    );
  });

  await assert.rejects(
    () => grantRewardOnce('guild-limit', 'balance-limit', 'daily_riddle', 'balance-limit', 'participation', 1),
    (error) => error.code === 'REWARD_BALANCE_LIMIT'
  );
  await assert.rejects(
    () => grantRewardOnce('guild-limit', 'earned-limit', 'daily_riddle', 'earned-limit', 'participation', 1),
    (error) => error.code === 'REWARD_TOTAL_EARNED_LIMIT'
  );

  const state = await withCoinTransaction((api) => ({
    players: api.all(
      `SELECT user_id, balance, total_earned FROM coin_wallets
       WHERE user_id IN ('balance-limit', 'earned-limit') ORDER BY user_id`
    ),
    grants: api.get("SELECT COUNT(*) AS count FROM reward_grants WHERE guild_id = 'guild-limit'").count,
    transactions: api.get("SELECT COUNT(*) AS count FROM coin_transactions WHERE guild_id = 'guild-limit'").count,
  }));

  assert.deepEqual(state.players, [
    { user_id: 'balance-limit', balance: Number.MAX_SAFE_INTEGER, total_earned: 0 },
    { user_id: 'earned-limit', balance: 0, total_earned: Number.MAX_SAFE_INTEGER },
  ]);
  assert.equal(Number(state.grants), 0);
  assert.equal(Number(state.transactions), 0);
});

test('feature outbox survives restart, retries with a lease, and delivers once', async () => {
  const base = new Date('2026-09-03T02:00:00.000Z');
  const queued = await enqueueFeatureOutbox({
    guildId: 'guild-outbox',
    featureKey: 'daily_riddle',
    eventType: 'publish',
    dedupeKey: '2026-09-03',
    payload: { promptId: 'synthetic-riddle' },
    now: base,
    availableAt: base,
  });
  const duplicate = await enqueueFeatureOutbox({
    guildId: 'guild-outbox',
    featureKey: 'daily_riddle',
    eventType: 'publish',
    dedupeKey: '2026-09-03',
    payload: { promptId: 'ignored-duplicate' },
    now: base,
    availableAt: base,
  });

  assert.equal(queued.alreadyEnqueued, false);
  assert.equal(duplicate.alreadyEnqueued, true);
  assert.deepEqual(duplicate.event.payload, { promptId: 'synthetic-riddle' });

  resetCoinDatabaseForTests();
  const firstClaim = await claimFeatureOutbox({ workerId: 'worker-a', now: base, leaseMs: 60_000 });
  assert.equal(firstClaim.length, 1);
  assert.equal(firstClaim[0].attemptCount, 1);

  const retried = await retryFeatureOutbox(firstClaim[0].id, {
    workerId: 'worker-a',
    error: new Error('synthetic failure'),
    delayMs: 1_000,
    now: base,
  });
  assert.equal(retried.updated, true);
  assert.equal(retried.event.status, 'pending');
  assert.equal(retried.event.lastError, 'synthetic failure');

  resetCoinDatabaseForTests();
  assert.deepEqual(
    await claimFeatureOutbox({ workerId: 'worker-b', now: new Date(base.getTime() + 999), leaseMs: 60_000 }),
    []
  );
  const secondClaim = await claimFeatureOutbox({
    workerId: 'worker-b',
    now: new Date(base.getTime() + 1_000),
    leaseMs: 60_000,
  });
  assert.equal(secondClaim.length, 1);
  assert.equal(secondClaim[0].attemptCount, 2);

  const delivered = await markFeatureOutboxDelivered(secondClaim[0].id, {
    workerId: 'worker-b',
    now: new Date(base.getTime() + 1_100),
  });
  assert.equal(delivered.updated, true);
  assert.equal(delivered.event.status, 'delivered');

  resetCoinDatabaseForTests();
  assert.deepEqual(
    await claimFeatureOutbox({ workerId: 'worker-c', now: new Date(base.getTime() + 120_000), leaseMs: 60_000 }),
    []
  );
});

test('feature outbox reclaims expired leases, rejects wrong workers, and rolls back malformed claims', async () => {
  const base = new Date('2026-09-03T02:00:00.000Z');
  const queued = await enqueueFeatureOutbox({
    guildId: 'guild-outbox-negative',
    featureKey: 'daily_riddle',
    eventType: 'publish',
    dedupeKey: 'lease',
    payload: { promptId: 'lease-fixture' },
    now: base,
    availableAt: base,
  });
  const [firstClaim] = await claimFeatureOutbox({ workerId: 'worker-a', now: base, leaseMs: 1_000 });

  const wrongWorker = await markFeatureOutboxDelivered(queued.event.id, {
    workerId: 'worker-b',
    now: new Date(base.getTime() + 100),
  });
  assert.equal(wrongWorker.updated, false);

  const [reclaimed] = await claimFeatureOutbox({
    workerId: 'worker-b',
    now: new Date(base.getTime() + 1_000),
    leaseMs: 1_000,
  });
  assert.equal(reclaimed.id, firstClaim.id);
  assert.equal(reclaimed.attemptCount, 2);

  const staleWorker = await retryFeatureOutbox(firstClaim.id, {
    workerId: 'worker-a',
    error: 'late worker',
    now: new Date(base.getTime() + 1_001),
  });
  assert.equal(staleWorker.updated, false);

  const malformed = await enqueueFeatureOutbox({
    guildId: 'guild-outbox-negative',
    featureKey: 'daily_riddle',
    eventType: 'publish',
    dedupeKey: 'malformed',
    payload: { promptId: 'will-be-corrupted' },
    now: base,
    availableAt: base,
  });
  await withCoinTransaction((api) => {
    api.run("UPDATE feature_outbox SET payload_json = '{' WHERE id = ?", [malformed.event.id]);
  });

  await assert.rejects(
    () => claimFeatureOutbox({ workerId: 'worker-c', now: new Date(base.getTime() + 1_001), leaseMs: 1_000 }),
    (error) => error.code === 'CORRUPT_DATA'
  );
  const malformedAfterFailure = await withCoinTransaction((api) =>
    api.get('SELECT status, attempt_count FROM feature_outbox WHERE id = ?', [malformed.event.id])
  );
  assert.deepEqual(malformedAfterFailure, { status: 'pending', attempt_count: 0 });
});

test('feature transactions restore the in-memory snapshot when their database write fails', async () => {
  await initializeCoinDatabase();
  const originalBytes = fs.readFileSync(dbPath);
  const originalRename = fs.renameSync;
  fs.renameSync = (sourcePath, targetPath) => {
    if (sourcePath === `${dbPath}.tmp` && targetPath === dbPath) {
      throw new Error('synthetic persistence failure');
    }
    return originalRename(sourcePath, targetPath);
  };

  try {
    await assert.rejects(
      () =>
        setGuildFeatureSetting('guild-persist-failure', 'word_chain', {
          enabled: true,
          now: new Date('2026-09-03T00:00:00.000Z'),
        }),
      /落盤失敗/
    );
  } finally {
    fs.renameSync = originalRename;
  }

  assert.deepEqual(fs.readFileSync(dbPath), originalBytes);
  assert.equal(fs.existsSync(`${dbPath}.tmp`), false);
  const setting = await getGuildFeatureSetting('guild-persist-failure', 'word_chain');
  const foreignKeys = await withCoinDatabase((api) => api.get('PRAGMA foreign_keys').foreign_keys);
  assert.equal(setting.persisted, false);
  assert.equal(Number(foreignKeys), 1);
});

test('feature flags default off and the router does not invoke disabled handlers', async () => {
  const setting = await getGuildFeatureSetting('guild-defaults', 'word_chain');
  const settings = await listGuildFeatureSettings('guild-defaults');
  let handlerCalls = 0;
  const router = createMessageFeatureRouter({
    handlers: {
      word_chain: async () => {
        handlerCalls += 1;
        return true;
      },
    },
  });
  const routeResult = await router({
    guildId: 'guild-defaults',
    channelId: 'channel-1',
    author: { id: 'synthetic-user', bot: false },
  });
  const storedRows = await withCoinTransaction((api) => api.get('SELECT COUNT(*) AS count FROM feature_guild_settings').count);

  assert.equal(setting.enabled, false);
  assert.equal(setting.guildId, 'guild-defaults');
  assert.equal(setting.persisted, false);
  assert.equal(settings.length, FEATURE_KEYS.length);
  assert.ok(settings.every((item) => item.enabled === false));
  assert.equal(routeResult.handled, false);
  assert.equal(handlerCalls, 0);
  assert.equal(Number(storedRows), 0);

  const enabled = await setGuildFeatureSetting('guild-defaults', 'word_chain', {
    enabled: true,
    channelId: 'channel-1',
    config: { locale: 'zh-TW' },
    now: new Date('2026-09-03T00:00:00.000Z'),
  });
  assert.equal(enabled.enabled, true);
  assert.deepEqual(enabled.config, { locale: 'zh-TW' });
});

test('feature usage is de-identified and feature health uses the constrained registry', async () => {
  const first = await recordFeatureUsage('daily_riddle', 'message', 2, new Date('2026-09-03T15:59:00.000Z'));
  const second = await recordFeatureUsage('daily_riddle', 'message', 3, new Date('2026-09-03T15:59:30.000Z'));
  await setFeatureHealth('daily_riddle', 'maintenance', {
    detail: 'synthetic maintenance',
    now: new Date('2026-09-03T16:00:00.000Z'),
  });
  const health = await listFeatureHealth();
  const usage = await listFeatureUsageForDate('2026-09-03');

  assert.equal(first.usageDate, '2026-09-03');
  assert.equal(second.usageCount, 5);
  assert.deepEqual(usage.find((row) => row.featureKey === 'daily_riddle' && row.metricKey === 'message'), {
    usageDate: '2026-09-03',
    featureKey: 'daily_riddle',
    metricKey: 'message',
    usageCount: 5,
    updatedAt: '2026-09-03T15:59:30.000Z',
  });
  assert.deepEqual(health, [
    {
      featureKey: 'daily_riddle',
      status: 'maintenance',
      detail: 'synthetic maintenance',
      updatedAt: '2026-09-03T16:00:00.000Z',
    },
  ]);
  await assert.rejects(
    () => recordFeatureUsage('daily_riddle', '123456789012345678', 1, new Date('2026-09-03T16:01:00.000Z')),
    (error) => error.code === 'INVALID_USAGE_METRIC'
  );
  await assert.rejects(
    () => recordFeatureUsage('daily_riddle', 'free-form-note', 1, new Date('2026-09-03T16:01:00.000Z')),
    (error) => error.code === 'INVALID_USAGE_METRIC'
  );
  await assert.rejects(
    () => listFeatureUsageForDate('2026/09/03'),
    (error) => error.code === 'INVALID_ARGUMENT'
  );
});

test('Taipei clock helpers handle midnight and daily schedule boundaries', () => {
  const beforeMidnight = new Date('2026-09-03T15:59:59.999Z');
  const midnight = new Date('2026-09-03T16:00:00.000Z');
  const beforeTen = new Date('2026-09-04T01:59:00.000Z');

  assert.equal(getTaipeiDateKey(beforeMidnight), '2026-09-03');
  assert.equal(getTaipeiMinuteOfDay(beforeMidnight), 23 * 60 + 59);
  assert.equal(getTaipeiDateKey(midnight), '2026-09-04');
  assert.equal(isTaipeiTime(midnight, 0, 0), true);
  assert.deepEqual(getTaipeiDayRange(midnight), {
    dateKey: '2026-09-04',
    start: midnight,
    endExclusive: new Date('2026-09-04T16:00:00.000Z'),
  });
  assert.equal(getNextTaipeiOccurrence(10, 0, beforeTen).toISOString(), '2026-09-04T02:00:00.000Z');
  assert.equal(
    getNextTaipeiOccurrence(21, 30, new Date('2026-09-04T13:30:00.000Z')).toISOString(),
    '2026-09-05T13:30:00.000Z'
  );
});

test('daily-riddle corpus and exact answer normalization stay deterministic without fuzzy matching', () => {
  assert.doesNotThrow(() => assertDailyRiddleCorpus());
  assert.ok(riddles.length >= 31);
  assert.equal(selectRiddleForDate('2026-09-04').id, selectRiddleForDate('2026-09-04').id);
  const water = riddles.find((riddle) => riddle.id === 'r012');
  assert.equal(normalizeDailyRiddleAnswer(' 答案是：Ｈ２Ｏ！ '), 'h2o');
  assert.equal(isCorrectDailyRiddleAnswer('答案為 H₂O。', water), true);
  assert.equal(isCorrectDailyRiddleAnswer('水', water), false);
  assert.equal(isEligibleRiddleMessage('🙂 <@123456789012345678>'), false);
  assert.equal(isEligibleRiddleMessage('我認為答案是水'), true);
  assert.equal(isEligibleRiddleMessage('哈哈哈哈哈哈'), false);
  assert.equal(isEligibleRiddleMessage('abababab'), false);
  assert.equal(isEligibleRiddleMessage('哈'), false);
  assert.equal(isEligibleRiddleMessage('a'), false);
  assert.equal(isEligibleRiddleMessage('1'), false);
  assert.equal(isEligibleRiddleMessage(water.canonicalAnswer, water), true);
});

test('daily-riddle publishes at 10:00, waits through 21:29, then reconciles history and rewards everyone exactly once', async () => {
  const discord = createFakeRiddleDiscord();
  await setGuildFeatureSetting('riddle-guild', 'daily_riddle', {
    enabled: true,
    channelId: 'riddle-parent',
    config: { corpusVersion: 'daily-riddles-v1' },
  });

  assert.equal(getRiddlePhase(new Date('2026-09-04T01:59:00.000Z')), 'before');
  assert.equal(getRiddlePhase(new Date('2026-09-04T02:00:00.000Z')), 'open');
  assert.equal(getRiddlePhase(new Date('2026-09-04T13:30:00.000Z')), 'settlement');
  await processDailyRiddleTick(discord.client, { now: new Date('2026-09-04T01:59:00.000Z') });
  assert.equal(discord.parentMessages.size, 0);

  const published = await processDailyRiddleTick(discord.client, { now: new Date('2026-09-04T02:00:00.000Z') });
  assert.equal(published.published, 1);
  assert.equal(discord.parentMessages.size, 1);
  const event = await getDailyRiddleEvent('riddle-guild', '2026-09-04');
  assert.equal(event.status, 'published');
  const riddle = riddles.find((entry) => entry.id === event.riddleId);

  discord.addHumanMessage({ id: 'answer-a', userId: 'user-a', content: `答案是：${riddle.canonicalAnswer}`, createdAt: '2026-09-04T03:00:00.000Z' });
  discord.addHumanMessage({ id: 'talk-b', userId: 'user-b', content: '我來一起討論這題', createdAt: '2026-09-04T04:00:00.000Z' });
  discord.addHumanMessage({ id: 'answer-c', userId: 'user-c', content: riddle.acceptedAliases[0] || riddle.canonicalAnswer, createdAt: '2026-09-04T05:00:00.000Z' });
  discord.addHumanMessage({ id: 'emoji-only', userId: 'user-d', content: '🙂🙂🙂', createdAt: '2026-09-04T06:00:00.000Z' });

  const beforeAnswer = await processDailyRiddleTick(discord.client, { now: new Date('2026-09-04T13:29:00.000Z') });
  assert.equal(beforeAnswer.settled, 0);
  discord.setNow('2026-09-04T13:30:00.000Z');
  const settled = await processDailyRiddleTick(discord.client, { now: new Date('2026-09-04T13:30:00.000Z') });
  assert.equal(settled.settled, 1);
  assert.equal((await getDailyRiddleEvent('riddle-guild', '2026-09-04')).status, 'settled');

  const state = await withCoinDatabase((api) => ({
    balances: api.all("SELECT user_id, balance, total_earned FROM coin_wallets WHERE user_id IN ('user-a', 'user-b', 'user-c') ORDER BY user_id"),
    grants: api.all("SELECT user_id, reward_kind, amount FROM reward_grants WHERE guild_id = 'riddle-guild' ORDER BY user_id, reward_kind"),
    messages: api.all('SELECT message_id, eligible, correct FROM daily_event_messages ORDER BY message_id'),
    eventColumns: api.all('PRAGMA table_info(daily_event_messages)').map((column) => column.name),
  }));
  assert.deepEqual(state.balances, [
    { user_id: 'user-a', balance: 80, total_earned: 80 },
    { user_id: 'user-b', balance: 30, total_earned: 30 },
    { user_id: 'user-c', balance: 80, total_earned: 80 },
  ]);
  assert.equal(state.grants.length, 5);
  assert.equal(state.eventColumns.includes('content'), false);
  assert.equal(state.eventColumns.includes('content_hash'), false);

  await processDailyRiddleTick(discord.client, { now: new Date('2026-09-04T13:31:00.000Z') });
  assert.equal(
    Number(await withCoinDatabase((api) => api.get("SELECT COUNT(*) AS count FROM reward_grants WHERE guild_id = 'riddle-guild'").count)),
    5
  );
});

test('daily-riddle recovers publish and answer markers after restart without duplicate Discord messages or rewards', async () => {
  const discord = createFakeRiddleDiscord();
  await setGuildFeatureSetting('riddle-guild', 'daily_riddle', { enabled: true, channelId: 'riddle-parent' });
  const first = await processDailyRiddleTick(discord.client, {
    now: new Date('2026-09-04T02:00:00.000Z'),
    hooks: { afterPublishSend: async () => { throw new Error('synthetic crash after publish'); } },
  });
  assert.equal(first.published, 0);
  assert.equal(discord.parentMessages.size, 1);
  for (let index = 0; index < 300; index += 1) {
    discord.addParentMessage({
      id: `newer-parent-${String(index).padStart(3, '0')}`,
      userId: `parent-user-${index}`,
      bot: false,
      content: 'newer parent message',
      createdAt: new Date(Date.parse('2026-09-04T02:00:01.000Z') + index * 1000),
    });
  }
  resetCoinDatabaseForTests();

  await processDailyRiddleTick(discord.client, {
    now: new Date('2026-09-04T02:06:00.000Z'),
    hooks: { maxMarkerPages: 4 },
  });
  assert.equal([...discord.parentMessages.values()].filter((message) => message.author.bot).length, 1);
  assert.equal(discord.threadStarts, 1);
  const event = await getDailyRiddleEvent('riddle-guild', '2026-09-04');
  assert.equal(event.status, 'published_late');
  const riddle = riddles.find((entry) => entry.id === event.riddleId);
  discord.addHumanMessage({ id: 'restart-answer', userId: 'restart-user', content: riddle.canonicalAnswer, createdAt: '2026-09-04T03:00:00.000Z' });

  discord.setNow('2026-09-04T13:30:00.000Z');
  await processDailyRiddleTick(discord.client, {
    now: new Date('2026-09-04T13:30:00.000Z'),
    hooks: { afterAnswerSend: async () => { throw new Error('synthetic crash after answer'); } },
  });
  assert.equal([...discord.threadMessages.values()].filter((message) => message.author.bot).length, 1);
  for (let index = 0; index < 300; index += 1) {
    discord.addHumanMessage({
      id: `newer-thread-${String(index).padStart(3, '0')}`,
      userId: `late-user-${index}`,
      content: '答案公布後的訊息',
      createdAt: new Date(Date.parse('2026-09-04T13:30:01.000Z') + index * 1000),
    });
  }
  resetCoinDatabaseForTests();
  await processDailyRiddleTick(discord.client, {
    now: new Date('2026-09-04T13:36:00.000Z'),
    hooks: { maxMarkerPages: 4 },
  });
  assert.equal([...discord.threadMessages.values()].filter((message) => message.author.bot).length, 1);
  assert.equal((await getDailyRiddleEvent('riddle-guild', '2026-09-04')).status, 'settled');
  assert.equal(
    Number(await withCoinDatabase((api) => api.get("SELECT COUNT(*) AS count FROM reward_grants WHERE user_id = 'restart-user'").count)),
    2
  );
});

test('daily-riddle creates and recovers announcement threads when Discord reports Unknown Channel for the message id', async () => {
  const fresh = createFakeRiddleDiscord({
    guildId: 'riddle-unknown-fresh',
    parentId: 'riddle-unknown-fresh-parent',
    threadId: 'riddle-unknown-fresh-thread',
    unknownChannelErrorCode: 10003,
  });
  await setGuildFeatureSetting('riddle-unknown-fresh', 'daily_riddle', {
    enabled: true,
    channelId: 'riddle-unknown-fresh-parent',
  });
  const freshResult = await processDailyRiddleTick(fresh.client, {
    now: new Date('2026-09-04T02:00:00.000Z'),
  });
  assert.equal(freshResult.published, 1);
  assert.equal(fresh.threadStarts, 1);
  assert.equal((await getDailyRiddleEvent('riddle-unknown-fresh', '2026-09-04')).status, 'published');

  const recovery = createFakeRiddleDiscord({
    guildId: 'riddle-unknown-recovery',
    parentId: 'riddle-unknown-recovery-parent',
    threadId: 'riddle-unknown-recovery-thread',
    unknownChannelErrorCode: 10003,
  });
  await setGuildFeatureSetting('riddle-unknown-recovery', 'daily_riddle', {
    enabled: true,
    channelId: 'riddle-unknown-recovery-parent',
  });
  await processDailyRiddleTick(recovery.client, {
    now: new Date('2026-09-04T02:00:00.000Z'),
    hooks: { afterPublishSend: async () => { throw new Error('synthetic restart after riddle announcement'); } },
  });
  assert.equal(recovery.parentMessages.size, 1);
  resetCoinDatabaseForTests();
  const recoveredResult = await processDailyRiddleTick(recovery.client, {
    now: new Date('2026-09-04T02:06:00.000Z'),
  });
  assert.equal(recoveredResult.published, 1);
  assert.equal(recovery.parentMessages.size, 1);
  assert.equal(recovery.threadStarts, 1);
  assert.equal((await getDailyRiddleEvent('riddle-unknown-recovery', '2026-09-04')).status, 'published_late');

  const forbidden = createFakeRiddleDiscord({
    guildId: 'riddle-channel-forbidden',
    parentId: 'riddle-channel-forbidden-parent',
    threadId: 'riddle-channel-forbidden-thread',
    unknownChannelErrorCode: 50013,
  });
  await setGuildFeatureSetting('riddle-channel-forbidden', 'daily_riddle', {
    enabled: true,
    channelId: 'riddle-channel-forbidden-parent',
  });
  const forbiddenResult = await processDailyRiddleTick(forbidden.client, {
    now: new Date('2026-09-04T02:00:00.000Z'),
  });
  assert.equal(forbiddenResult.published, 0);
  assert.equal(forbidden.threadStarts, 0);
  assert.equal((await getDailyRiddleEvent('riddle-channel-forbidden', '2026-09-04')).lastError, 'publish:50013');
});

test('daily-riddle publish lease serializes concurrent ticks to one announcement and one thread', async () => {
  const discord = createFakeRiddleDiscord();
  await setGuildFeatureSetting('riddle-guild', 'daily_riddle', { enabled: true, channelId: 'riddle-parent' });
  const now = new Date('2026-09-04T02:00:00.000Z');

  const results = await Promise.all([
    processDailyRiddleTick(discord.client, { now }),
    processDailyRiddleTick(discord.client, { now }),
  ]);

  assert.equal(results.reduce((count, result) => count + result.published, 0), 1);
  assert.equal([...discord.parentMessages.values()].filter((message) => message.author.bot).length, 1);
  assert.equal(discord.threadStarts, 1);
  const event = await getDailyRiddleEvent('riddle-guild', '2026-09-04');
  assert.equal(event.status, 'published');
  assert.equal(event.publishLeaseOwner, null);
  assert.equal(event.publishLeaseUntil, null);
});

test('daily-riddle publish lease can be recovered only after expiry and stale owners cannot persist', async () => {
  const discord = createFakeRiddleDiscord();
  const first = await claimDailyRiddleEvent({
    guildId: 'riddle-guild',
    parentChannelId: 'riddle-parent',
    localDate: '2026-09-04',
    now: new Date('2026-09-04T02:00:00.000Z'),
  });
  const held = await claimDailyRiddleEvent({
    guildId: 'riddle-guild',
    parentChannelId: 'riddle-parent',
    localDate: '2026-09-04',
    now: new Date('2026-09-04T02:14:59.000Z'),
  });
  assert.equal(first.claimed, true);
  assert.equal(held.claimed, false);

  const recoveredAt = new Date('2026-09-04T02:15:00.000Z');
  const recovered = await claimDailyRiddleEvent({
    guildId: 'riddle-guild',
    parentChannelId: 'riddle-parent',
    localDate: '2026-09-04',
    now: recoveredAt,
  });
  assert.equal(recovered.claimed, true);
  await assert.rejects(
    () => publishDailyRiddle(discord.client, first.event, {
      now: recoveredAt,
      leaseOwner: first.leaseOwner,
    }),
    (error) => error.code === 'PUBLISH_LEASE_LOST'
  );
  discord.setNow(recoveredAt);
  await publishDailyRiddle(discord.client, recovered.event, {
    now: recoveredAt,
    leaseOwner: recovered.leaseOwner,
  });
  assert.equal(discord.parentMessages.size, 1);
  assert.equal(discord.threadStarts, 1);
  assert.equal((await getDailyRiddleEvent('riddle-guild', '2026-09-04')).status, 'published_late');
});

test('daily-riddle cutoff fence invalidates an active publish lease and cleans its new announcement', async () => {
  const discord = createFakeRiddleDiscord();
  await setGuildFeatureSetting('riddle-guild', 'daily_riddle', { enabled: true, channelId: 'riddle-parent' });
  const beforeCutoff = new Date('2026-09-04T13:29:59.000Z');
  const cutoff = new Date('2026-09-04T13:30:00.000Z');
  let fenceResult;

  const publishing = await processDailyRiddleTick(discord.client, {
    now: beforeCutoff,
    hooks: {
      afterPublishSend: async () => {
        fenceResult = await processDailyRiddleTick(discord.client, { now: cutoff });
      },
    },
  });

  assert.equal(fenceResult.missed, 1);
  assert.equal(publishing.published, 0);
  assert.equal(discord.parentMessages.size, 0);
  assert.equal(discord.parentDeletes, 1);
  assert.equal(discord.threadStarts, 0);
  const event = await getDailyRiddleEvent('riddle-guild', '2026-09-04');
  assert.equal(event.status, 'missed');
  assert.equal(event.publishLeaseOwner, null);
  assert.equal(event.publishLeaseUntil, null);
  assert.equal(event.announcementMessageId, null);
});

test('daily-riddle revalidates cutoff after parent send and after thread creation before persistence', async () => {
  let discord = createFakeRiddleDiscord();
  await setGuildFeatureSetting('riddle-guild', 'daily_riddle', { enabled: true, channelId: 'riddle-parent' });
  const beforeCutoff = new Date('2026-09-04T13:29:59.000Z');
  const cutoff = new Date('2026-09-04T13:30:00.000Z');
  let clock = beforeCutoff;
  await processDailyRiddleTick(discord.client, {
    now: beforeCutoff,
    hooks: {
      nowFn: () => clock,
      afterPublishSend: async () => { clock = cutoff; },
    },
  });
  assert.equal(discord.parentMessages.size, 0);
  assert.equal(discord.parentDeletes, 1);
  assert.equal(discord.threadStarts, 0);
  assert.equal((await getDailyRiddleEvent('riddle-guild', '2026-09-04')).status, 'missed');

  resetCoinDatabaseForTests({ allowCreateOnNextOpen: true });
  fs.rmSync(dbPath, { force: true });
  discord = createFakeRiddleDiscord();
  await setGuildFeatureSetting('riddle-guild', 'daily_riddle', { enabled: true, channelId: 'riddle-parent' });
  clock = beforeCutoff;
  await processDailyRiddleTick(discord.client, {
    now: beforeCutoff,
    hooks: {
      nowFn: () => clock,
      afterThreadCreate: async () => { clock = cutoff; },
    },
  });
  assert.equal(discord.parentMessages.size, 0);
  assert.equal(discord.parentDeletes, 1);
  assert.equal(discord.threadStarts, 1);
  assert.equal(discord.threadDeletes, 1);
  assert.equal((await getDailyRiddleEvent('riddle-guild', '2026-09-04')).status, 'missed');
});

test('daily-riddle blocks publish and answer recovery when marker history exceeds the safe page cap', async () => {
  let discord = createFakeRiddleDiscord();
  await setGuildFeatureSetting('riddle-guild', 'daily_riddle', { enabled: true, channelId: 'riddle-parent' });
  await processDailyRiddleTick(discord.client, {
    now: new Date('2026-09-04T02:00:00.000Z'),
    hooks: { afterPublishSend: async () => { throw new Error('synthetic publish crash'); } },
  });
  for (let index = 0; index < 300; index += 1) {
    discord.addParentMessage({
      id: `publish-cap-${String(index).padStart(3, '0')}`,
      userId: `parent-cap-user-${index}`,
      bot: false,
      content: 'newer parent message',
      createdAt: new Date(Date.parse('2026-09-04T02:00:01.000Z') + index * 1000),
    });
  }
  await processDailyRiddleTick(discord.client, {
    now: new Date('2026-09-04T02:06:00.000Z'),
    hooks: { maxMarkerPages: 3 },
  });
  assert.equal((await getDailyRiddleEvent('riddle-guild', '2026-09-04')).status, 'blocked');
  assert.equal([...discord.parentMessages.values()].filter((message) => message.author.bot).length, 1);
  assert.equal(discord.threadStarts, 0);

  resetCoinDatabaseForTests({ allowCreateOnNextOpen: true });
  fs.rmSync(dbPath, { force: true });
  discord = createFakeRiddleDiscord();
  await setGuildFeatureSetting('riddle-guild', 'daily_riddle', { enabled: true, channelId: 'riddle-parent' });
  await processDailyRiddleTick(discord.client, { now: new Date('2026-09-04T02:00:00.000Z') });
  const event = await getDailyRiddleEvent('riddle-guild', '2026-09-04');
  const riddle = riddles.find((entry) => entry.id === event.riddleId);
  discord.addHumanMessage({
    id: 'answer-before-cap', userId: 'cap-user', content: riddle.canonicalAnswer,
    createdAt: '2026-09-04T03:00:00.000Z',
  });
  discord.setNow('2026-09-04T13:30:00.000Z');
  await processDailyRiddleTick(discord.client, {
    now: new Date('2026-09-04T13:30:00.000Z'),
    hooks: { afterAnswerSend: async () => { throw new Error('synthetic answer crash'); } },
  });
  for (let index = 0; index < 300; index += 1) {
    discord.addHumanMessage({
      id: `answer-cap-${String(index).padStart(3, '0')}`,
      userId: `answer-cap-user-${index}`,
      content: '答案公布後的訊息',
      createdAt: new Date(Date.parse('2026-09-04T13:30:01.000Z') + index * 1000),
    });
  }
  await processDailyRiddleTick(discord.client, {
    now: new Date('2026-09-04T13:36:00.000Z'),
    hooks: { maxMarkerPages: 3 },
  });
  assert.equal((await getDailyRiddleEvent('riddle-guild', '2026-09-04')).status, 'blocked');
  assert.equal([...discord.threadMessages.values()].filter((message) => message.author.bot).length, 1);
  assert.equal(Number(await withCoinDatabase((api) => api.get('SELECT COUNT(*) AS count FROM reward_grants').count)), 0);
});

test('daily-riddle settlement freezes gateway writes and reconciles only delayed pre-cutoff history', async () => {
  const discord = createFakeRiddleDiscord();
  await setGuildFeatureSetting('riddle-guild', 'daily_riddle', { enabled: true, channelId: 'riddle-parent' });
  await processDailyRiddleTick(discord.client, { now: new Date('2026-09-04T02:00:00.000Z') });
  const event = await getDailyRiddleEvent('riddle-guild', '2026-09-04');
  const riddle = riddles.find((entry) => entry.id === event.riddleId);
  discord.addHumanMessage({
    id: 'delayed-before-cutoff', userId: 'delayed-user', content: riddle.canonicalAnswer,
    createdAt: '2026-09-04T13:29:59.000Z',
  });
  discord.addHumanMessage({
    id: 'after-cutoff', userId: 'late-user', content: riddle.canonicalAnswer,
    createdAt: '2026-09-04T13:30:00.000Z',
  });
  const cutoff = new Date('2026-09-04T13:30:00.000Z');
  const claim = await claimDailyRiddleSettlement(event.id, cutoff);
  assert.equal(claim.claimed, true);
  assert.equal(claim.event.status, 'settling');
  const heldClaim = await claimDailyRiddleSettlement(event.id, new Date('2026-09-04T13:44:59.000Z'));
  assert.equal(heldClaim.claimed, false);
  const gatewayRace = await recordDailyRiddleMessage({
    guildId: event.guildId,
    threadId: event.threadId,
    messageId: 'gateway-race',
    userId: 'gateway-user',
    content: riddle.canonicalAnswer,
    createdAt: new Date('2026-09-04T13:29:58.000Z'),
    operationNow: cutoff,
  });
  assert.equal(gatewayRace.recorded, false);

  const recoveredAt = new Date('2026-09-04T13:45:00.000Z');
  const recovered = await claimDailyRiddleSettlement(event.id, recoveredAt);
  assert.equal(recovered.claimed, true);
  await assert.rejects(
    () => settleDailyRiddle(discord.client, claim.event, { now: recoveredAt, leaseOwner: claim.leaseOwner }),
    (error) => error.code === 'SETTLE_LEASE_LOST'
  );
  discord.setNow(recoveredAt);
  const settled = await settleDailyRiddle(discord.client, recovered.event, {
    now: recoveredAt,
    leaseOwner: recovered.leaseOwner,
  });
  assert.equal(settled.settled, true);
  const stored = await withCoinDatabase((api) => ({
    messages: api.all('SELECT message_id FROM daily_event_messages ORDER BY message_id').map((row) => row.message_id),
    participants: api.all('SELECT user_id FROM daily_event_participants ORDER BY user_id').map((row) => row.user_id),
    grants: api.all('SELECT reward_kind FROM reward_grants ORDER BY reward_kind').map((row) => row.reward_kind),
  }));
  assert.deepEqual(stored.messages, ['delayed-before-cutoff']);
  assert.deepEqual(stored.participants, ['delayed-user']);
  assert.deepEqual(stored.grants, ['correct_answer', 'participation']);
  const afterFreeze = await recordDailyRiddleMessage({
    guildId: event.guildId,
    threadId: event.threadId,
    messageId: 'after-freeze',
    userId: 'after-freeze-user',
    content: riddle.canonicalAnswer,
    createdAt: new Date('2026-09-04T13:29:57.000Z'),
    operationNow: recoveredAt,
  });
  assert.equal(afterFreeze.recorded, false);
});

test('daily-riddle resumes a partial reward pass without duplicate grants after a crash', async () => {
  const discord = createFakeRiddleDiscord();
  await setGuildFeatureSetting('riddle-guild', 'daily_riddle', { enabled: true, channelId: 'riddle-parent' });
  await processDailyRiddleTick(discord.client, { now: new Date('2026-09-04T02:00:00.000Z') });
  const event = await getDailyRiddleEvent('riddle-guild', '2026-09-04');
  const riddle = riddles.find((entry) => entry.id === event.riddleId);
  discord.addHumanMessage({ id: 'partial-correct', userId: 'a-correct', content: riddle.canonicalAnswer, createdAt: '2026-09-04T03:00:00.000Z' });
  discord.addHumanMessage({ id: 'partial-talk', userId: 'b-talk', content: '我想一起認真討論', createdAt: '2026-09-04T04:00:00.000Z' });
  discord.setNow('2026-09-04T13:30:00.000Z');
  let crashed = false;
  await processDailyRiddleTick(discord.client, {
    now: new Date('2026-09-04T13:30:00.000Z'),
    hooks: {
      afterRewardGrant: async () => {
        if (!crashed) {
          crashed = true;
          throw new Error('synthetic partial reward crash');
        }
      },
    },
  });
  assert.equal((await getDailyRiddleEvent('riddle-guild', '2026-09-04')).status, 'rewarding');
  assert.equal(Number(await withCoinDatabase((api) => api.get('SELECT COUNT(*) AS count FROM reward_grants').count)), 1);

  resetCoinDatabaseForTests();
  const resumed = await processDailyRiddleTick(discord.client, { now: new Date('2026-09-04T13:31:00.000Z') });
  assert.equal(resumed.settled, 1);
  const finalState = await withCoinDatabase((api) => ({
    grants: api.all('SELECT user_id, reward_kind, amount FROM reward_grants ORDER BY user_id, reward_kind'),
    balances: api.all("SELECT user_id, balance FROM coin_wallets WHERE user_id IN ('a-correct', 'b-talk') ORDER BY user_id"),
  }));
  assert.deepEqual(finalState.grants, [
    { user_id: 'a-correct', reward_kind: 'correct_answer', amount: 50 },
    { user_id: 'a-correct', reward_kind: 'participation', amount: 30 },
    { user_id: 'b-talk', reward_kind: 'participation', amount: 30 },
  ]);
  assert.deepEqual(finalState.balances, [
    { user_id: 'a-correct', balance: 80 },
    { user_id: 'b-talk', balance: 30 },
  ]);
});

test('daily-riddle marks late and missed occurrences and crosses the Taipei midnight boundary without backfill', async () => {
  let discord = createFakeRiddleDiscord();
  await setGuildFeatureSetting('riddle-guild', 'daily_riddle', { enabled: true, channelId: 'riddle-parent' });
  await processDailyRiddleTick(discord.client, { now: new Date('2026-09-04T03:00:00.000Z') });
  assert.equal((await getDailyRiddleEvent('riddle-guild', '2026-09-04')).status, 'published_late');

  resetCoinDatabaseForTests({ allowCreateOnNextOpen: true });
  fs.rmSync(dbPath, { force: true });
  discord = createFakeRiddleDiscord();
  await setGuildFeatureSetting('riddle-guild', 'daily_riddle', { enabled: true, channelId: 'riddle-parent' });
  await processDailyRiddleTick(discord.client, { now: new Date('2026-09-04T13:30:00.000Z') });
  assert.equal((await getDailyRiddleEvent('riddle-guild', '2026-09-04')).status, 'missed');
  assert.equal(discord.parentMessages.size, 0);
  await processDailyRiddleTick(discord.client, { now: new Date('2026-09-04T16:00:00.000Z') });
  assert.equal(getTaipeiDateKey(new Date('2026-09-04T16:00:00.000Z')), '2026-09-05');
  assert.equal(await getDailyRiddleEvent('riddle-guild', '2026-09-05'), null);
});

test('daily-riddle blocks incomplete history before answer announcement or any payout', async () => {
  const discord = createFakeRiddleDiscord();
  await setGuildFeatureSetting('riddle-guild', 'daily_riddle', { enabled: true, channelId: 'riddle-parent' });
  await processDailyRiddleTick(discord.client, { now: new Date('2026-09-04T02:00:00.000Z') });
  for (let index = 0; index < 100; index += 1) {
    discord.addHumanMessage({
      id: `page-${String(index).padStart(3, '0')}`,
      userId: `user-${index}`,
      content: '有效討論',
      createdAt: new Date(Date.parse('2026-09-04T03:00:00.000Z') + index * 1000),
    });
  }
  const result = await processDailyRiddleTick(discord.client, {
    now: new Date('2026-09-04T13:30:00.000Z'),
    hooks: { maxHistoryPages: 1 },
  });
  assert.equal(result.blocked, 1);
  assert.equal((await getDailyRiddleEvent('riddle-guild', '2026-09-04')).status, 'blocked');
  assert.equal(
    Number(await withCoinDatabase((api) => api.get('SELECT COUNT(*) AS count FROM reward_grants').count)),
    0
  );
  assert.equal([...discord.threadMessages.values()].some((message) => message.author.bot), false);
});

test('daily-riddle message routing isolates guild/thread, records before mention handling, and scheduler is immediate and unrefed', async () => {
  const discord = createFakeRiddleDiscord();
  await setGuildFeatureSetting('riddle-guild', 'daily_riddle', { enabled: true, channelId: 'riddle-parent' });
  await processDailyRiddleTick(discord.client, { now: new Date('2026-09-04T02:00:00.000Z') });
  const event = await getDailyRiddleEvent('riddle-guild', '2026-09-04');
  const ordinaryMessage = {
    id: 'route-ordinary', guildId: 'riddle-guild', channelId: event.threadId, content: '我來參加討論',
    createdAt: new Date('2026-09-04T03:00:00.000Z'), author: { id: 'route-user', bot: false },
    client: discord.client, mentions: { has: () => false },
  };
  const ordinary = await handleDailyRiddleMessage(ordinaryMessage);
  const routed = await routeMessageFeatures({ ...ordinaryMessage, id: 'route-ordinary-through-router' });
  const mentioned = await handleDailyRiddleMessage({
    id: 'route-mentioned', guildId: 'riddle-guild', channelId: event.threadId, content: '<@bot-user> 我猜答案',
    createdAt: new Date('2026-09-04T03:01:00.000Z'), author: { id: 'mention-user', bot: false },
    client: discord.client, mentions: { has: () => true },
  });
  const isolated = await recordDailyRiddleMessage({
    guildId: 'other-guild', threadId: event.threadId, messageId: 'wrong-guild', userId: 'other-user',
    content: '不應記錄', createdAt: new Date('2026-09-04T03:02:00.000Z'),
  });
  assert.equal(ordinary, true);
  assert.deepEqual(routed, { handled: true, featureKey: 'daily_riddle' });
  assert.equal(mentioned, false);
  assert.equal(isolated.inRiddleThread, false);

  stopDailyRiddleScheduler();
  assert.equal(getNextRiddleBoundaryDelay(new Date('2026-09-04T01:59:31.000Z')), 29_000);
  assert.equal(getNextRiddleBoundaryDelay(new Date('2026-09-04T13:29:31.000Z')), 29_000);
  let timeoutUnrefCalled = false;
  let intervalUnrefCalled = false;
  let timeoutCallback;
  let intervalCallback;
  let timeoutDelay;
  let ticks = 0;
  const timers = await startDailyRiddleScheduler(discord.client, {
    nowFn: () => new Date('2026-09-04T01:59:31.000Z'),
    tick: async () => { ticks += 1; },
    setTimeoutFn: (callback, delay) => {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return { unref: () => { timeoutUnrefCalled = true; } };
    },
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return { unref: () => { intervalUnrefCalled = true; } };
    },
  });
  assert.equal(ticks, 1);
  assert.equal(timeoutDelay, 29_000);
  assert.equal(timeoutUnrefCalled, true);
  assert.equal(intervalUnrefCalled, true);
  timeoutCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ticks, 2);
  await intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ticks, 3);
  let clearedTimeout;
  let clearedInterval;
  assert.equal(stopDailyRiddleScheduler({
    clearTimeoutFn: (value) => { clearedTimeout = value; },
    clearIntervalFn: (value) => { clearedInterval = value; },
  }), true);
  assert.equal(clearedTimeout, timers.boundaryTimer);
  assert.equal(clearedInterval, timers.watchdogTimer);

  resetCoinDatabaseForTests({ allowCreateOnNextOpen: true });
  fs.rmSync(dbPath, { force: true });
  const defaultsOff = createFakeRiddleDiscord();
  await processDailyRiddleTick(defaultsOff.client, { now: new Date('2026-09-04T02:00:00.000Z') });
  assert.equal(defaultsOff.parentMessages.size, 0);
});

test('daily checkin grants coins once and survives service restart', async () => {
  const first = await dailyCheckin('guild-1', 'user-1', new Date('2026-05-17T03:00:00.000Z'));

  assert.equal(first.earned, 50);
  assert.equal(first.player.balance, 50);
  assert.equal(first.streak, 1);

  await assert.rejects(
    () => dailyCheckin('guild-1', 'user-1', new Date('2026-05-17T08:00:00.000Z')),
    (error) => error instanceof CoinServiceError && error.code === 'ALREADY_CHECKED_IN'
  );

  resetCoinDatabaseForTests();
  const balance = await getPlayerBalance('guild-1', 'user-1');

  assert.equal(balance.balance, 50);
  assert.equal(balance.lastDailyDate, '2026-05-17');
});

test('shop purchase deducts balance, writes inventory, and enforces purchase limit', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 200,
    operatorId: 'admin-1',
    reason: 'test funds',
  });
  const item = await createShopItem('guild-1', {
    name: '測試徽章',
    description: '測試用收藏道具',
    price: 75,
    type: 'collectible',
    stock: 2,
    purchaseLimit: 1,
    createdBy: 'admin-1',
  });
  const purchase = await purchaseItem('guild-1', 'user-1', item.id, 1);
  const balance = await getPlayerBalance('guild-1', 'user-1');
  const inventory = await getInventory('guild-1', 'user-1');

  assert.equal(purchase.totalPrice, 75);
  assert.equal(balance.balance, 125);
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].itemName, '測試徽章');
  assert.equal(inventory[0].quantity, 1);

  await assert.rejects(
    () => purchaseItem('guild-1', 'user-1', item.id, 1),
    (error) => error instanceof CoinServiceError && error.code === 'PURCHASE_LIMIT'
  );
});

test('fixed deposits lock rates and appear in balance summaries', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 5000,
    operatorId: 'admin-1',
    reason: 'test funds',
  });
  await setFixedRate('guild-1', 7, 1, { operatorId: 'admin-1', reason: 'test rate' });
  const fixed = await createFixedDeposit('guild-1', 'user-1', { amount: 1000, termDays: 7 });
  const summary = await getBalanceSummary('guild-1', 'user-1');
  const allSummaries = await getAllBalanceSummaries('guild-1');
  const deposits = await listFixedDeposits('guild-1', { userId: 'user-1' });

  assert.equal(fixed.rate, 0.01);
  assert.equal(fixed.expectedInterest, 10);
  assert.equal(summary.walletBalance, 4000);
  assert.equal(summary.fixedPrincipal, 1000);
  assert.equal(summary.fixedExpectedInterest, 10);
  assert.equal(summary.totalAssets, 5010);
  assert.equal(allSummaries[0].totalAssets, 5010);
  assert.equal(deposits.length, 1);
});

test('chip exchange buys at 1:1 and cashes out with tiered fees', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 700_500,
    operatorId: 'admin-1',
    reason: 'test funds',
  });

  const bought = await buyChips('guild-1', 'user-1', 600_500);
  const lowCashout = await cashoutChips('guild-1', 'user-1', 500_000);
  const highCashout = await cashoutChips('guild-1', 'user-1', 100_500);
  const balance = await getPlayerBalance('guild-1', 'user-1');
  const chips = await getChipBalance('guild-1', 'user-1');

  assert.equal(bought.balanceAfter, 600_500);
  assert.equal(lowCashout.fee, 100);
  assert.equal(lowCashout.coinAmount, 499_900);
  assert.equal(highCashout.fee, 100);
  assert.equal(highCashout.coinAmount, 100_400);
  assert.equal(chips.balance, 0);
  assert.equal(balance.balance, 700_300);

  await buyChips('guild-1', 'user-1', 500_001);
  const thresholdCashout = await cashoutChips('guild-1', 'user-1', 500_001);

  assert.equal(thresholdCashout.fee, 200);
  assert.equal(thresholdCashout.coinAmount, 499_801);
});

test('casino loans borrow chips, accrue coin-denominated debt, and repay with chips', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 5000,
    operatorId: 'admin-1',
    reason: 'test funds',
  });

  const borrowed = await borrowCasinoLoan('guild-1', 'user-1', {
    amount: 1000,
    date: new Date('2026-05-20T04:00:00.000Z'),
  });
  const dayOne = await getCasinoLoanStatus('guild-1', 'user-1', {
    date: new Date('2026-05-21T04:00:00.000Z'),
  });
  const dayTwo = await getCasinoLoanStatus('guild-1', 'user-1', {
    date: new Date('2026-05-22T04:00:00.000Z'),
  });
  const partial = await repayCasinoLoan('guild-1', 'user-1', {
    amount: 61,
    date: new Date('2026-05-22T05:00:00.000Z'),
  });
  const final = await repayCasinoLoan('guild-1', 'user-1', {
    amount: 2000,
    date: new Date('2026-05-22T06:00:00.000Z'),
  });
  const balance = await getPlayerBalance('guild-1', 'user-1');
  const chips = await getChipBalance('guild-1', 'user-1');

  assert.equal(borrowed.borrowedAmount, 1000);
  assert.equal(borrowed.balanceAfter, 1000);
  assert.equal(dayOne.loan.currentDebtAmount, 1030);
  assert.equal(dayOne.interestApplied, 30);
  assert.equal(dayTwo.loan.currentDebtAmount, 1061);
  assert.equal(dayTwo.interestApplied, 31);
  assert.equal(partial.repaymentAmount, 61);
  assert.equal(partial.loan.currentDebtAmount, 1000);
  assert.equal(final.repaymentAmount, 1000);
  assert.equal(final.loan.status, 'repaid');
  assert.equal(final.loan.currentDebtAmount, 0);
  assert.equal(final.autoTopUpAmount, 61);
  assert.equal(balance.balance, 4939);
  assert.equal(chips.balance, 0);
});

test('casino loan relief reduces interest gradually and floors at half rate', async () => {
  await borrowCasinoLoan('guild-1', 'user-1', {
    amount: 1000,
    date: new Date('2026-05-20T04:00:00.000Z'),
  });

  let lastRelief;
  for (let index = 0; index < 10; index += 1) {
    lastRelief = await applyCasinoLoanRelief('guild-1', 'user-1', {
      operatorId: 'owner-1',
      reason: `relief ${index + 1}`,
      date: new Date('2026-05-20T05:00:00.000Z'),
    });
  }

  assert.equal(lastRelief.reliefCount, 10);
  assert.equal(lastRelief.newRate, 0.015);

  await assert.rejects(
    () =>
      applyCasinoLoanRelief('guild-1', 'user-1', {
        operatorId: 'owner-1',
        reason: 'over limit',
        date: new Date('2026-05-20T06:00:00.000Z'),
      }),
    (error) => error instanceof CoinServiceError && error.code === 'CASINO_LOAN_RELIEF_LIMIT'
  );

  const status = await getCasinoDebtStatus('guild-1', 'user-1', {
    date: new Date('2026-05-21T04:00:00.000Z'),
  });
  const publicHistory = await listCasinoHistory('guild-1', 'user-1', { limit: 25 });

  assert.equal(status.loan.interestRate, 0.015);
  assert.equal(status.loan.currentDebtAmount, 1015);
  assert.equal(status.interestApplied, 15);
  assert.equal(publicHistory.some((row) => row.entryType === 'loan_relief'), false);
});

test('casino forced collection uses wallet then demand deposit and never touches fixed deposits', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 9000,
    operatorId: 'admin-1',
    reason: 'test funds',
  });
  const fixed = await createFixedDeposit('guild-1', 'user-1', { amount: 1000, termDays: 7 });
  await borrowCasinoLoan('guild-1', 'user-1', {
    amount: 4000,
    date: new Date('2026-05-20T04:00:00.000Z'),
  });
  await deposit('guild-1', 'user-1', 7500);

  const collected = await collectCasinoDebt('guild-1', 'user-1', {
    amount: 3000,
    operatorId: 'owner-1',
    reason: 'internal collection',
    date: new Date('2026-05-20T05:00:00.000Z'),
  });
  const summary = await getBalanceSummary('guild-1', 'user-1');
  const fixedDeposits = await listFixedDeposits('guild-1', { userId: 'user-1' });
  const publicHistory = await listCasinoHistory('guild-1', 'user-1', { limit: 25 });

  assert.equal(collected.collectionAmount, 3000);
  assert.equal(collected.walletCollected, 500);
  assert.equal(collected.bankCollected, 2500);
  assert.equal(collected.debtAfter, 1000);
  assert.equal(summary.walletBalance, 0);
  assert.equal(summary.bankBalance, 5000);
  assert.equal(summary.fixedPrincipal, 1000);
  assert.equal(fixedDeposits[0].id, fixed.id);
  assert.equal(fixedDeposits[0].status, 'active');
  assert.equal(fixedDeposits[0].principal, 1000);
  assert.equal(publicHistory.some((row) => row.entryType === 'loan_forced_collection'), false);
});

test('casino dice and slots settle against chips and auto top up from wallet', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 1000,
    operatorId: 'admin-1',
    reason: 'test funds',
  });

  const dice = await playDice('guild-1', 'user-1', {
    amount: 100,
    choice: 'big',
    rng: () => 3,
  });
  const slotValues = [4, 4, 4];
  const slots = await playSlots('guild-1', 'user-1', {
    amount: 100,
    rng: () => slotValues.shift(),
  });
  const balance = await getPlayerBalance('guild-1', 'user-1');
  const chips = await getChipBalance('guild-1', 'user-1');

  assert.deepEqual(dice.game.result.dice, [4, 4]);
  assert.equal(dice.payoutAmount, 200);
  assert.equal(dice.netAmount, 100);
  assert.equal(dice.autoTopUpAmount, 100);
  assert.deepEqual(slots.game.result.reels, ['七', '七', '七']);
  assert.equal(slots.payoutAmount, 1000);
  assert.equal(slots.netAmount, 900);
  assert.equal(balance.balance, 900);
  assert.equal(chips.balance, 1100);
});

test('casino roulette, baccarat, and poker settle as chip games', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 10_000,
    operatorId: 'admin-1',
    reason: 'casino funds',
  });

  const roulette = await playRoulette('guild-1', 'user-1', {
    amount: 100,
    choice: 'red',
    rng: () => 1,
  });
  const baccarat = await playBaccarat('guild-1', 'user-1', {
    amount: 100,
    choice: 'player',
    rng: () => 0,
  });
  const poker = await playPoker('guild-1', 'user-1', {
    amount: 100,
    rng: () => 0,
  });

  assert.equal(roulette.game.gameType, 'roulette');
  assert.equal(roulette.game.result.number, 1);
  assert.equal(roulette.game.result.color, 'red');
  assert.equal(baccarat.game.gameType, 'baccarat');
  assert.ok(['player', 'banker', 'tie'].includes(baccarat.game.result.outcome));
  assert.equal(poker.game.gameType, 'poker');
  assert.ok(['win', 'lose', 'push'].includes(poker.game.result.outcome));
});

test('casino blackjack settles natural, hit bust, and stand outcomes', async () => {
  assert.equal(getHandValue(['AS', 'AH', '9C']), 21);

  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 1000,
    operatorId: 'admin-1',
    reason: 'test funds',
  });
  const natural = await startBlackjack('guild-1', 'user-1', {
    amount: 100,
    deck: ['AS', 'KH', '9C', '7D'],
  });

  assert.equal(natural.session.status, 'settled');
  assert.equal(natural.session.payoutAmount, 250);
  assert.equal(natural.session.netAmount, 150);
  assert.equal(natural.autoTopUpAmount, 100);
  assert.equal((await getPlayerBalance('guild-1', 'user-1')).balance, 900);
  assert.equal((await getChipBalance('guild-1', 'user-1')).balance, 250);

  const hitStart = await startBlackjack('guild-1', 'user-1', {
    amount: 100,
    deck: ['10S', '7H', '9C', '7D', '8S'],
  });
  const hitResult = await hitBlackjack('guild-1', 'user-1', hitStart.session.id);

  assert.equal(hitResult.session.status, 'settled');
  assert.equal(hitResult.session.result.outcome, 'lose');
  assert.equal(hitResult.session.netAmount, -100);
  assert.equal((await getChipBalance('guild-1', 'user-1')).balance, 150);

  const standStart = await startBlackjack('guild-1', 'user-1', {
    amount: 100,
    deck: ['10S', '8H', '9C', '7D', '10D'],
  });
  const standResult = await standBlackjack('guild-1', 'user-1', standStart.session.id);

  assert.equal(standResult.session.status, 'settled');
  assert.equal(standResult.session.result.outcome, 'win');
  assert.equal(standResult.session.payoutAmount, 200);
  assert.equal((await getChipBalance('guild-1', 'user-1')).balance, 250);
  assert.equal((await getPlayerBalance('guild-1', 'user-1')).balance, 900);
});

test('casino blackjack timeout refunds the escrowed bet', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 1000,
    operatorId: 'admin-1',
    reason: 'test funds',
  });

  const started = await startBlackjack('guild-1', 'user-1', {
    amount: 100,
    deck: ['10S', '7H', '9C', '7D', '8S'],
    date: new Date('2026-05-20T00:00:00.000Z'),
  });
  const afterStart = await getPlayerBalance('guild-1', 'user-1');
  const expired = await processExpiredBlackjackSessions({
    date: new Date('2026-05-20T00:11:00.000Z'),
  });
  const afterRefund = await getPlayerBalance('guild-1', 'user-1');
  const chips = await getChipBalance('guild-1', 'user-1');

  assert.equal(started.session.status, 'active');
  assert.equal(started.autoTopUpAmount, 100);
  assert.equal(afterStart.balance, 900);
  assert.equal(expired.refunded, 1);
  assert.equal(afterRefund.balance, 900);
  assert.equal(chips.balance, 100);
});

test('work job list uses updated rank, salary, and report channel data', async () => {
  const info = await listJobs();
  const byName = new Map(info.jobs.map((job) => [job.name, job]));

  assert.equal(byName.get('會計師').salary, 500);
  assert.equal(byName.get('會計師').rank, '正一品官員');
  assert.equal(byName.get('會計師').reportChannelName, '會計師');
  assert.equal(byName.get('老師').salary, 400);
  assert.equal(byName.get('翻譯官').salary, 300);
  assert.equal(byName.get('翻譯官').externalServerBonus, 200);
  assert.equal(byName.get('小幫手').salary, 200);
  assert.equal(byName.get('清潔工').salary, 100);
  assert.equal(byName.get('迎賓員').salary, 50);
  assert.equal(byName.get('廚師').salary, 70);
  assert.equal(byName.get('調酒師').salary, 60);
  assert.equal(byName.get('服務生').salary, 0);
  assert.equal(byName.get('制服服務生').salary, 0);
});

test('casino venue menu seeds defaults and accepts user-added items', async () => {
  const meals = await listVenueMenu('guild-1', { itemType: VenueItemType.MEAL });
  const created = await addVenueMenuItem('guild-1', {
    itemType: VenueItemType.DRINK,
    name: '測試蜂蜜茶',
    steps: '加入蜂蜜\n倒入熱茶\n攪拌後上桌',
    createdBy: 'user-1',
  });
  const drinks = await listVenueMenu('guild-1', { itemType: VenueItemType.DRINK });

  assert.ok(meals.some((item) => item.name === '小吉炒飯'));
  assert.equal(created.itemType, VenueItemType.DRINK);
  assert.ok(drinks.some((item) => item.id === created.id && item.name === '測試蜂蜜茶'));
});

test('venue staff can select exactly one global primary job', async () => {
  await assert.rejects(() => startVenueJobs('2001', '1001', {
    days: 10, chef: true, bartender: true, waiter: '制服服務生',
  }), { code: 'ONE_PRIMARY_JOB_REQUIRED' });
  const selected = await startVenueJobs('2001', '1001', { days: 10, waiter: '制服服務生' });
  assert.equal(selected.jobName, '制服服務生');
  assert.equal(selected.state, 'pending_legacy');
  await assert.rejects(() => startJob('2002', '1001', '廚師', 5), { code: 'PRIMARY_JOB_EXISTS' });
});

test('casino venue orders assign active staff and require assigned makers to complete items', async () => {
  await activatePrimaryForFixture('2001', '1001', '廚師', 70);
  await activatePrimaryForFixture('2002', '1002', '調酒師', 60);
  await activatePrimaryForFixture('2003', '1003', '服務生', 0);
  await fundVenueFixture('2001', '3001', 100);
  const membership = await verifiedVenueFixture('2001', ['1001', '1002', '1003']);
  const meal = (await listVenueMenu('2001', { itemType: VenueItemType.MEAL }))[0];
  const drink = (await listVenueMenu('2001', { itemType: VenueItemType.DRINK }))[0];

  const result = await createVenueOrder('2001', '3001', {
    mealId: meal.id,
    drinkId: drink.id,
    chefId: '1001',
    bartenderId: '1002',
    waiterId: '1003',
    tipAmount: 50,
    membership,
  });
  const mealItem = result.items.find((item) => item.itemType === VenueItemType.MEAL);
  const drinkItem = result.items.find((item) => item.itemType === VenueItemType.DRINK);

  assert.equal(result.items.length, 2);
  assert.equal(mealItem.makerUserId, '1001');
  assert.equal(drinkItem.makerUserId, '1002');
  assert.equal(result.order.waiterUserId, '1003');
  assert.equal(result.order.waiterGlobalCycleId !== null, true);
  assert.equal(result.order.tipAmount, 50);
  assert.equal(mealItem.status, 'pending');

  const recipe = await getVenueRecipe('2001', '1001', mealItem.id);
  assert.equal(recipe.id, mealItem.id);
  await assert.rejects(
    () => getVenueRecipe('2001', '3001', mealItem.id),
    (error) => error instanceof CoinServiceError && error.code === 'VENUE_RECIPE_OWNER_ONLY'
  );

  const completedMeal = await completeVenueOrderItem('2001', '1001', mealItem.id, {
    steps: '熱鍋\n下飯\n調味\n盛盤',
  });
  await completeVenueOrderItem('2001', '1002', drinkItem.id, {
    steps: '加冰\n倒入飲料\n攪拌\n裝飾',
  });
  const served = await serveVenueOrder('2001', '1003', result.order.id);
  const chefTasks = await listWorkTasks('2001', { userId: '1001', limit: 10 });
  const waiterChips = await getChipBalance('2001', '1003');
  const customerChips = await getChipBalance('2001', '3001');

  assert.equal(completedMeal.item.status, 'completed');
  assert.equal(completedMeal.item.actualSteps, '熱鍋\n下飯\n調味\n盛盤');
  assert.equal(served.order.tipStatus, 'paid');
  assert.equal(waiterChips.balance, 50);
  assert.equal(customerChips.balance, 50);
  assert.ok(chefTasks.some((task) => task.taskType === 'casino_venue_meal' && task.status === 'completed'));
});

test('casino venue chef bonus is paid through regular payroll after the tenth completed meal', async () => {
  const chefCycle = await activatePrimaryForFixture('2001', '1001', '廚師', 70);
  await activatePrimaryForFixture('2001', '1002', '服務生', 0);
  const membership = await verifiedVenueFixture('2001', ['1001', '1002']);
  const meal = (await listVenueMenu('2001', { itemType: VenueItemType.MEAL }))[0];
  const baseDate = new Date();

  for (let index = 0; index < 11; index += 1) {
    const date = new Date(baseDate.getTime() + index * 1000);
    const customerId = String(3000 + index);
    await fundVenueFixture('2001', customerId, 50);
    const order = await createVenueOrder('2001', customerId, {
      mealId: meal.id,
      chefId: '1001',
      waiterId: '1002',
      tipAmount: 50,
      date,
      membership,
    });
    await completeVenueOrderItem('2001', '1001', order.items[0].id, {
      steps: `備料 ${index}\n加熱\n調味\n出餐`,
      date: new Date(date.getTime() + 500),
    });
  }

  const result = await duePrimaryForFixture(chefCycle);
  const payroll = await getPrimaryPayrollHistory('1001');
  const player = await getPlayerBalance('2001', '1001');
  const bonusRows = await withCoinTransaction((api) =>
    api.all('SELECT bonus_amount, bonus_paid FROM casino_venue_order_items WHERE guild_id = ? ORDER BY id ASC', [
      '2001',
    ])
  );

  assert.equal(result.settled, 1);
  assert.equal(payroll[0].grossAmount, 90);
  assert.equal(payroll[0].paidAmount, 90);
  assert.equal(player.balance, 90);
  assert.equal(bonusRows.filter((row) => Number(row.bonus_amount) === 20).length, 1);
  assert.equal(bonusRows.filter((row) => Number(row.bonus_paid) === 1).length, 1);
});

test('casino venue enforces per-user order rate limit', async () => {
  await activatePrimaryForFixture('2001', '1001', '服務生', 0);
  await fundVenueFixture('2001', '3001', 600);
  const membership = await verifiedVenueFixture('2001', ['1001'], { completeRoster: true });
  const meal = (await listVenueMenu('2001', { itemType: VenueItemType.MEAL }))[0];
  const baseDate = new Date();

  for (let index = 0; index < 10; index += 1) {
    await createVenueOrder('2001', '3001', {
      mealId: meal.id,
      waiterId: '1001',
      tipAmount: 50,
      date: new Date(baseDate.getTime() + index * 1000),
      membership,
    });
  }

  await assert.rejects(
    () =>
      createVenueOrder('2001', '3001', {
        mealId: meal.id,
        waiterId: '1001',
        tipAmount: 50,
        date: new Date(baseDate.getTime() + 10 * 1000),
        membership,
      }),
    (error) => error instanceof CoinServiceError && error.code === 'VENUE_ORDER_RATE_LIMIT'
  );
});

test('luxury shop uses independent inventory and pawn redemption uses historical high price', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 10_000,
    operatorId: 'admin-1',
    reason: 'test funds',
  });
  const luxury = await createLuxuryItem('guild-1', {
    name: '限量名錶',
    description: '奢侈品測試商品',
    price: 1000,
    stock: 3,
    purchaseLimit: 3,
    createdBy: 'admin-1',
  });
  await purchaseLuxuryItem('guild-1', 'user-1', luxury.id, 2);
  const regularInventory = await getInventory('guild-1', 'user-1');
  const luxuryInventory = await getLuxuryInventory('guild-1', 'user-1');

  assert.equal(regularInventory.length, 0);
  assert.equal(luxuryInventory.items.length, 1);
  assert.equal(luxuryInventory.items[0].itemName, '限量名錶');
  assert.equal(luxuryInventory.items[0].quantity, 2);

  const pawned = await pawnLuxuryItem('guild-1', 'user-1', luxury.id, 1);
  await editLuxuryItem('guild-1', luxury.id, {
    price: 1500,
    operatorId: 'admin-1',
  });
  await editLuxuryItem('guild-1', luxury.id, {
    price: 900,
    operatorId: 'admin-1',
  });
  const redeemed = await redeemPawnRecord('guild-1', 'user-1', pawned.record.id, 1);
  const balance = await getPlayerBalance('guild-1', 'user-1');
  const finalLuxuryInventory = await getLuxuryInventory('guild-1', 'user-1');

  assert.equal(pawned.payoutAmount, 800);
  assert.equal(redeemed.redeemUnitPrice, 1500);
  assert.equal(redeemed.totalPrice, 1500);
  assert.equal(balance.balance, 7300);
  assert.equal(finalLuxuryInventory.items[0].quantity, 2);
});

test('casino lodging and duel tower use chips and shop battle items', async () => {
  await adjustPlayerBalance('guild-1', 'user-1', {
    action: 'add',
    amount: 20_000,
    operatorId: 'admin-1',
    reason: 'casino facility funds',
  });
  const booking = await bookLodging('guild-1', 'user-1', {
    roomType: 'deluxe',
    nights: 2,
    date: new Date('2026-05-20T04:00:00.000Z'),
  });

  assert.equal(booking.booking.roomName, '豪華套房');
  assert.equal(booking.booking.chipAmount, 600);
  assert.equal(booking.autoTopUpAmount, 600);

  const weapon = await createShopItem('guild-1', {
    name: '塔台訓練劍',
    description: '決鬥塔台測試武器',
    price: 1000,
    type: ShopItemTypes.BATTLE_ITEM,
    stock: null,
    purchaseLimit: null,
    createdBy: 'admin-1',
  });
  await purchaseItem('guild-1', 'user-1', weapon.id, 1);

  const weapons = await listOwnedBattleWeapons('guild-1', 'user-1');
  const duel = await enterDuelTower('guild-1', 'user-1', {
    weaponItemId: weapon.id,
    wager: 100,
    rng: () => 10,
  });
  const profile = await getDuelTowerProfile('guild-1', 'user-1');

  assert.equal(weapons.length, 1);
  assert.equal(duel.run.weaponName, '塔台訓練劍');
  assert.equal(duel.run.status, 'win');
  assert.equal(duel.run.netAmount, 100);
  assert.equal(profile.wins, 1);
  assert.equal(profile.nextFloor, 2);
});

test('casino venue expired pending items are completed by npc, penalized, and waiter tips refund', async () => {
  await activatePrimaryForFixture('2001', '1001', '廚師', 70);
  await activatePrimaryForFixture('2001', '1002', '服務生', 0);
  await fundVenueFixture('2001', '3001', 50);
  const membership = await verifiedVenueFixture('2001', ['1001', '1002']);
  const meal = (await listVenueMenu('2001', { itemType: VenueItemType.MEAL }))[0];
  const order = await createVenueOrder('2001', '3001', {
    mealId: meal.id,
    chefId: '1001',
    waiterId: '1002',
    tipAmount: 50,
    membership,
  });

  assert.equal(order.items[0].status, 'pending');

  const future = new Date(Date.now() + 25 * 60 * 60 * 1000);
  const expired = await processExpiredVenueOrderItems({ date: future });
  await processExpiredWorkTasks(null, { date: future });
  const history = await listVenueHistory('2001', { limit: 1 });
  const tasks = await listWorkTasks('2001', { userId: '1001', limit: 10 });
  const penalties = await withCoinDatabase((api) => api.all(
    "SELECT amount FROM coin_primary_cycle_penalties WHERE user_id = '1001'"
  ));
  const customerChips = await getChipBalance('2001', '3001');

  assert.equal(expired.completedByNpc, 1);
  assert.equal(expired.waiterRefunded, 1);
  assert.equal(history[0].status, 'completed');
  assert.equal(history[0].makerIsNpc, true);
  assert.ok(tasks.some((task) => task.status === 'system_completed'));
  assert.equal(penalties[0].amount, 70);
  assert.equal(customerChips.balance, 50);
});

test('work payroll requires a valid submission and pays the full updated salary', async () => {
  const cycleId = await activatePrimaryForFixture('2001', '1001', '會計師', 500);
  const report = await reportWork('2001', '1001', {
    taskType: 'test_report',
    description: '完成一筆測試工作',
    channelName: '會計師',
  });
  const result = await duePrimaryForFixture(cycleId);
  const payroll = await getPrimaryPayrollHistory('1001');
  const player = await getPlayerBalance('2001', '1001');
  const tasks = await listWorkTasks('2001', { userId: '1001', limit: 10 });

  assert.equal(result.settled, 1);
  assert.equal(payroll.length, 1);
  assert.equal(payroll[0].grossAmount, 500);
  assert.equal(payroll[0].paidAmount, 500);
  assert.equal(player.balance, 500);
  assert.ok(tasks.some((task) => task.id === report.task.id && task.status === 'paid'));
});

test('work payroll skips payment when no valid submission exists', async () => {
  const cycleId = await activatePrimaryForFixture('2001', '1001', '迎賓員', 50);
  const result = await duePrimaryForFixture(cycleId);
  const payroll = await getPrimaryPayrollHistory('1001');
  const player = await getPlayerBalance('2001', '1001');

  assert.equal(result.settled, 1);
  assert.equal(payroll[0].payRatio, 0);
  assert.equal(payroll[0].paidAmount, 0);
  assert.equal(player.balance, 0);
});

test('work payroll pays 75 percent basic salary when no work is available', async () => {
  const cycleId = await activatePrimaryForFixture('2001', '1001', '迎賓員', 50);
  const report = await reportWork('2001', '1001', {
    noWorkAvailable: true,
    channelName: '迎賓員',
  });
  const result = await duePrimaryForFixture(cycleId);
  const payroll = await getPrimaryPayrollHistory('1001');
  const player = await getPlayerBalance('2001', '1001');
  const tasks = await listWorkTasks('2001', { userId: '1001', limit: 10 });
  const paidTask = tasks.find((task) => task.id === report.task.id);

  assert.equal(result.settled, 1);
  assert.equal(payroll[0].payRatio, 0.75);
  assert.equal(payroll[0].paidAmount, 38);
  assert.equal(player.balance, 38);
  assert.equal(paidTask.status, 'paid');
});

test('expired primary tasks are penalized per task and an approved appeal refunds actual withheld pay', async () => {
  const cycleId = await activatePrimaryForFixture('2001', '1001', '老師', 400);
  await addPendingTask('2001', '1001', {
    taskType: 'lesson-plan',
    description: '準備課程',
    dueHours: 1,
  });
  await addPendingTask('2001', '1001', {
    taskType: 'lesson-review',
    description: '整理課後重點',
    dueHours: 1,
  });
  await reportWork('2001', '1001', {
    taskType: 'lesson', description: '仍有完成一筆有效工作', channelName: '老師',
  });

  const expired = await processExpiredWorkTasks(null, {
    date: new Date(Date.now() + 25 * 60 * 60 * 1000),
  });
  const penalties = await withCoinDatabase((api) => api.all(
    'SELECT * FROM coin_primary_cycle_penalties WHERE cycle_id = ? ORDER BY id', [cycleId]
  ));
  const tasks = await listWorkTasks('2001', { userId: '1001', limit: 10 });

  assert.equal(expired.primary.completed, 2);
  assert.equal(penalties.length, 2);
  assert.equal(penalties[0].amount, 400);
  assert.equal(tasks.filter((task) => task.status === 'system_completed').length, 2);

  await duePrimaryForFixture(cycleId);
  const payroll = await getPrimaryPayrollHistory('1001');
  const afterPenalty = await getPlayerBalance('2001', '1001');

  assert.equal(payroll[0].paidAmount, 0);
  assert.equal(afterPenalty.balance, 0);

  const appeal = await createPrimaryPenaltyAppeal('1001', penalties[0].id, {
    reason: '當日已補交證明，請審核。',
  });
  const priorOwnerId = process.env.BOT_OWNER_ID;
  process.env.BOT_OWNER_ID = '9001';
  let reviewed;
  try {
    reviewed = await reviewPrimaryPenaltyAppeal('9001', appeal.appealId, {
      action: 'approved', reason: '申訴通過',
    });
  } finally {
    if (priorOwnerId === undefined) delete process.env.BOT_OWNER_ID;
    else process.env.BOT_OWNER_ID = priorOwnerId;
  }
  const afterRefund = await getPlayerBalance('2001', '1001');

  assert.equal(reviewed.status, 'approved');
  assert.equal(reviewed.refund.amount, 400);
  assert.equal(afterRefund.balance, 400);
});

test('translator payroll adds external server bonus and de-duplicates server ids per Taiwan date', async () => {
  const cycleId = await activatePrimaryForFixture('2001', '1001', '翻譯官', 300);
  await reportWork('2001', '1001', {
    taskType: 'translation',
    description: '完成外交翻譯與宣傳',
    channelName: '翻譯官',
    externalServerIds: ['4001', '4002', '4001'],
  });
  await duePrimaryForFixture(cycleId);
  const payroll = await getPrimaryPayrollHistory('1001');
  const player = await getPlayerBalance('2001', '1001');

  assert.equal(payroll[0].paidAmount, 700);
  assert.equal(player.balance, 700);
});

test('work submissions can be edited, reviewed back to pending, and soft-deleted', async () => {
  await activatePrimaryForFixture('2001', '1001', '老師', 400);
  const submitted = await reportWork('2001', '1001', {
    taskType: 'teaching',
    description: '三個知識點初稿',
    channelName: '老師',
  });
  const approved = await reviewWorkSubmission('2001', '9001', submitted.task.id, {
    action: 'approved',
    reason: '內容完整',
  });
  const edited = await editWorkSubmission('2001', '1001', submitted.task.id, {
    description: '修正後的三個知識點',
  });
  const deleted = await deleteWorkSubmission('2001', '1001', submitted.task.id);

  assert.equal(submitted.task.status, 'pending');
  assert.equal(approved.status, 'approved');
  assert.equal(edited.status, 'pending');
  assert.equal(edited.description, '修正後的三個知識點');
  assert.equal(deleted.status, 'deleted');
  assert.ok(deleted.deletedAt);
});

test('users cannot edit or delete other users submissions', async () => {
  await activatePrimaryForFixture('2001', '1001', '清潔工', 100);
  const submitted = await reportWork('2001', '1001', {
    description: '回報錯頻整理',
    channelName: '清潔工',
  });

  await assert.rejects(
    () =>
      editWorkSubmission('2001', '1002', submitted.task.id, {
        description: '不是本人的修改',
      }),
    (error) => error instanceof CoinServiceError && error.code === 'NOT_OWN_SUBMISSION'
  );
  await assert.rejects(
    () => deleteWorkSubmission('2001', '1002', submitted.task.id),
    (error) => error instanceof CoinServiceError && error.code === 'NOT_OWN_SUBMISSION'
  );
});

test('deleted submissions are excluded from payroll and paid submissions are locked', async () => {
  const cycleId = await activatePrimaryForFixture('2001', '1001', '小幫手', 200);
  const deleted = await reportWork('2001', '1001', {
    description: '錯誤提交',
    channelName: '小幫手',
  });
  await deleteWorkSubmission('2001', '1001', deleted.task.id);
  const valid = await reportWork('2001', '1001', {
    description: '完成三件以內雜務',
    channelName: '小幫手',
  });
  await duePrimaryForFixture(cycleId);
  const payroll = await getPrimaryPayrollHistory('1001');
  const tasks = await listWorkTasks('2001', { userId: '1001', limit: 10 });
  const paidTask = tasks.find((task) => task.id === valid.task.id);

  assert.equal(payroll[0].paidAmount, 200);
  assert.equal(paidTask.status, 'paid');

  await assert.rejects(
    () => editWorkSubmission('2001', '1001', valid.task.id, { description: '發薪後修改' }),
    (error) => error instanceof CoinServiceError && error.code === 'SUBMISSION_ALREADY_PAID'
  );
  await assert.rejects(
    () => deleteWorkSubmission('2001', '1001', valid.task.id),
    (error) => error instanceof CoinServiceError && error.code === 'SUBMISSION_ALREADY_PAID'
  );
});

test('daily-discussion corpus, Taipei window, and meaningful eligibility are deterministic and answer-free', () => {
  assert.doesNotThrow(() => assertDailyDiscussionCorpus());
  assert.ok(discussionTopics.length >= 31);
  assert.equal(discussionCorpusVersion, 'daily-discussions-v1');
  assert.equal(selectDiscussionForDate('2026-09-04').id, selectDiscussionForDate('2026-09-04').id);
  for (const topic of discussionTopics) {
    assert.equal('canonicalAnswer' in topic, false);
    assert.equal('acceptedAliases' in topic, false);
    assert.match(topic.safetyReminder, /Discord/);
  }
  assert.deepEqual(getDiscussionWindow('2026-09-04'), {
    dateKey: '2026-09-04',
    start: new Date('2026-09-03T16:00:00.000Z'),
    endExclusive: new Date('2026-09-04T16:00:00.000Z'),
  });
  assert.equal(isEligibleDiscussionMessage('我支持這個做法'), true);
  assert.equal(isEligibleDiscussionMessage('🙂🙂 <@123456789012345678>'), false);
  assert.equal(isEligibleDiscussionMessage('哈哈哈哈哈哈'), false);
  assert.equal(isEligibleDiscussionMessage('abababab'), false);
  assert.equal(isEligibleDiscussionMessage('哈'), false);
  assert.equal(isEligibleDiscussionMessage('a'), false);
  assert.equal(isEligibleDiscussionMessage('1'), false);
});

test('daily-discussion publishes exactly once at Taipei midnight and router isolates its thread from riddle', async () => {
  const discord = createFakeRiddleDiscord({
    guildId: 'discussion-concurrent',
    parentId: 'discussion-parent',
    threadId: 'discussion-thread',
  });
  await setGuildFeatureSetting('discussion-concurrent', 'daily_discussion', {
    enabled: true,
    channelId: 'discussion-parent',
    config: { corpusVersion: discussionCorpusVersion },
  });
  const midnight = new Date('2026-09-03T16:00:00.000Z');
  discord.setNow(midnight);
  const results = await Promise.all([
    processDailyDiscussionTick(discord.client, { now: midnight }),
    processDailyDiscussionTick(discord.client, { now: midnight }),
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.published, 0), 1);
  assert.equal(discord.parentMessages.size, 1);
  assert.equal(discord.threadStarts, 1);
  const event = await getDailyDiscussionEvent('discussion-concurrent', '2026-09-04');
  assert.equal(event.status, 'published');
  assert.equal(event.eventKind, 'discussion');

  const message = {
    id: 'discussion-route-message',
    guildId: 'discussion-concurrent',
    channelId: event.threadId,
    content: '我認為公共討論需要互相尊重',
    createdAt: new Date('2026-09-03T17:00:00.000Z'),
    author: { id: 'discussion-route-user', bot: false },
    client: discord.client,
    mentions: { has: () => false },
  };
  assert.equal(await handleDailyDiscussionMessage(message), true);
  assert.deepEqual(await routeMessageFeatures({ ...message, id: 'discussion-router-message' }), {
    handled: true,
    featureKey: 'daily_discussion',
  });
  assert.deepEqual(await routeMessageFeatures({ ...message, id: 'discussion-webhook', webhookId: 'webhook-1' }), {
    handled: false,
    featureKey: null,
  });
  assert.equal((await recordDailyRiddleMessage({
    guildId: event.guildId,
    threadId: event.threadId,
    messageId: 'riddle-isolation',
    userId: 'riddle-isolation-user',
    content: '這不是猜謎討論串',
    createdAt: new Date('2026-09-03T17:01:00.000Z'),
  })).inRiddleThread, false);

  const riddle = await claimDailyRiddleEvent({
    guildId: 'coexist-guild',
    parentChannelId: 'coexist-riddle-parent',
    localDate: '2026-09-06',
    now: new Date('2026-09-06T02:00:00.000Z'),
  });
  const discussion = await claimDailyDiscussionEvent({
    guildId: 'coexist-guild',
    parentChannelId: 'coexist-discussion-parent',
    localDate: '2026-09-06',
    now: new Date('2026-09-05T16:00:00.000Z'),
  });
  assert.equal(riddle.claimed, true);
  assert.equal(discussion.claimed, true);
  assert.equal(Number(await withCoinDatabase((api) => api.get(
    "SELECT COUNT(*) AS count FROM daily_events WHERE guild_id = 'coexist-guild' AND local_date = '2026-09-06'"
  ).count)), 2);
});

test('daily-discussion creates and recovers announcement threads when Discord reports Unknown Channel for the message id', async () => {
  const fresh = createFakeRiddleDiscord({
    guildId: 'discussion-unknown-fresh',
    parentId: 'discussion-unknown-fresh-parent',
    threadId: 'discussion-unknown-fresh-thread',
    unknownChannelErrorCode: 10003,
  });
  await setGuildFeatureSetting('discussion-unknown-fresh', 'daily_discussion', {
    enabled: true,
    channelId: 'discussion-unknown-fresh-parent',
  });
  const freshResult = await processDailyDiscussionTick(fresh.client, {
    now: new Date('2026-09-03T16:00:00.000Z'),
  });
  assert.equal(freshResult.published, 1);
  assert.equal(fresh.threadStarts, 1);
  assert.equal((await getDailyDiscussionEvent('discussion-unknown-fresh', '2026-09-04')).status, 'published');

  const recovery = createFakeRiddleDiscord({
    guildId: 'discussion-unknown-recovery',
    parentId: 'discussion-unknown-recovery-parent',
    threadId: 'discussion-unknown-recovery-thread',
    unknownChannelErrorCode: 10003,
  });
  await setGuildFeatureSetting('discussion-unknown-recovery', 'daily_discussion', {
    enabled: true,
    channelId: 'discussion-unknown-recovery-parent',
  });
  await processDailyDiscussionTick(recovery.client, {
    now: new Date('2026-09-03T16:00:00.000Z'),
    hooks: { afterPublishSend: async () => { throw new Error('synthetic restart after discussion announcement'); } },
  });
  assert.equal(recovery.parentMessages.size, 1);
  resetCoinDatabaseForTests();
  const recoveredResult = await processDailyDiscussionTick(recovery.client, {
    now: new Date('2026-09-03T16:06:00.000Z'),
  });
  assert.equal(recoveredResult.published, 1);
  assert.equal(recovery.parentMessages.size, 1);
  assert.equal(recovery.threadStarts, 1);
  assert.equal((await getDailyDiscussionEvent('discussion-unknown-recovery', '2026-09-04')).status, 'published_late');

  const forbidden = createFakeRiddleDiscord({
    guildId: 'discussion-channel-forbidden',
    parentId: 'discussion-channel-forbidden-parent',
    threadId: 'discussion-channel-forbidden-thread',
    unknownChannelErrorCode: 50013,
  });
  await setGuildFeatureSetting('discussion-channel-forbidden', 'daily_discussion', {
    enabled: true,
    channelId: 'discussion-channel-forbidden-parent',
  });
  const forbiddenResult = await processDailyDiscussionTick(forbidden.client, {
    now: new Date('2026-09-03T16:00:00.000Z'),
  });
  assert.equal(forbiddenResult.published, 0);
  assert.equal(forbidden.threadStarts, 0);
  assert.equal((await getDailyDiscussionEvent('discussion-channel-forbidden', '2026-09-04')).lastError, 'publish:50013');
});

test('daily-discussion stale publisher never deletes an announcement adopted by a recovered lease', async () => {
  async function runInterleaving(suffix, resumeAt) {
    const guildId = `discussion-lease-adoption-${suffix}`;
    const discord = createFakeRiddleDiscord({
      guildId,
      parentId: `${guildId}-parent`,
      threadId: `${guildId}-thread`,
    });
    await setGuildFeatureSetting(guildId, 'daily_discussion', {
      enabled: true,
      channelId: `${guildId}-parent`,
    });
    const firstStartedAt = new Date('2026-09-03T16:00:00.000Z');
    const recoveredAt = new Date('2026-09-03T16:16:00.000Z');
    let firstClock = firstStartedAt;
    let releaseFirst;
    let markFirstSent;
    const firstSent = new Promise((resolve) => { markFirstSent = resolve; });
    const firstCanResume = new Promise((resolve) => { releaseFirst = resolve; });
    discord.setNow(firstStartedAt);

    const firstTick = processDailyDiscussionTick(discord.client, {
      now: firstStartedAt,
      hooks: {
        nowFn: () => firstClock,
        afterPublishSend: async () => {
          markFirstSent();
          await firstCanResume;
        },
      },
    });
    await firstSent;

    discord.setNow(recoveredAt);
    const recoveredTick = await processDailyDiscussionTick(discord.client, { now: recoveredAt });
    assert.equal(recoveredTick.published, 1);
    const recoveredEvent = await getDailyDiscussionEvent(guildId, '2026-09-04');
    assert.equal(recoveredEvent.status, 'published_late');
    assert.equal(recoveredEvent.announcementMessageId, [...discord.parentMessages.keys()][0]);
    assert.equal(recoveredEvent.threadId, discord.thread.id);

    firstClock = resumeAt;
    releaseFirst();
    await firstTick;
    assert.equal(discord.parentDeletes, 0);
    assert.equal(discord.threadDeletes, 0);
    assert.equal(discord.parentMessages.size, 1);
    assert.equal((await getDailyDiscussionEvent(guildId, '2026-09-04')).status, 'published_late');
  }

  await runInterleaving('before-cutoff', new Date('2026-09-03T16:16:00.000Z'));
  await runInterleaving('at-cutoff', new Date('2026-09-04T16:00:00.000Z'));
});

test('daily-discussion includes 23:59:59, excludes next midnight, rewards unlimited users once, and settles concurrently', async () => {
  const discord = createFakeRiddleDiscord({
    guildId: 'discussion-rewards',
    parentId: 'discussion-rewards-parent',
    threadId: 'discussion-rewards-thread',
  });
  await setGuildFeatureSetting('discussion-rewards', 'daily_discussion', {
    enabled: true,
    channelId: 'discussion-rewards-parent',
  });
  const start = new Date('2026-09-03T16:00:00.000Z');
  await processDailyDiscussionTick(discord.client, { now: start });
  for (let index = 0; index < 105; index += 1) {
    discord.addHumanMessage({
      id: `discussion-user-message-${index}`,
      userId: `discussion-user-${String(index).padStart(3, '0')}`,
      content: `我認為第 ${index} 個觀點值得進一步討論`,
      createdAt: new Date(start.getTime() + 3_600_000 + index * 1000),
    });
  }
  discord.addHumanMessage({
    id: 'discussion-duplicate-user',
    userId: 'discussion-user-000',
    content: '同一位使用者補充第二個完整觀點',
    createdAt: new Date(start.getTime() + 7_200_000),
  });
  discord.addHumanMessage({
    id: 'discussion-last-second',
    userId: 'discussion-last-user',
    content: '我在最後一秒提出仍有意義的看法',
    createdAt: '2026-09-04T15:59:59.000Z',
  });
  discord.addHumanMessage({
    id: 'discussion-next-midnight',
    userId: 'discussion-excluded-user',
    content: '這則訊息已經屬於隔天的討論窗口',
    createdAt: '2026-09-04T16:00:00.000Z',
  });
  const cutoff = new Date('2026-09-04T16:00:00.000Z');
  discord.setNow(cutoff);
  const results = await Promise.all([
    processDailyDiscussionTick(discord.client, { now: cutoff }),
    processDailyDiscussionTick(discord.client, { now: cutoff }),
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.settled, 0), 1);
  assert.equal((await getDailyDiscussionEvent('discussion-rewards', '2026-09-04')).status, 'settled');
  const state = await withCoinDatabase((api) => ({
    grants: api.all("SELECT user_id, reward_kind, amount FROM reward_grants WHERE guild_id = 'discussion-rewards'"),
    participantCount: api.get(`SELECT COUNT(*) AS count FROM daily_event_participants AS participant
      JOIN daily_events AS event ON event.id = participant.event_id
      WHERE event.guild_id = 'discussion-rewards' AND event.event_kind = 'discussion' AND event.local_date = '2026-09-04'`).count,
    excludedCount: api.get("SELECT COUNT(*) AS count FROM coin_guild_players WHERE guild_id = 'discussion-rewards' AND user_id = 'discussion-excluded-user'").count,
    duplicateBalance: api.get("SELECT balance FROM coin_wallets WHERE user_id = 'discussion-user-000'").balance,
    messageColumns: api.all('PRAGMA table_info(daily_event_messages)').map((column) => column.name),
  }));
  assert.equal(state.grants.length, 106);
  assert.equal(state.participantCount, 106);
  assert.equal(Number(state.excludedCount), 0);
  assert.equal(state.duplicateBalance, 30);
  assert.ok(state.grants.every((grant) => grant.reward_kind === 'participation' && grant.amount === 30));
  assert.equal(state.messageColumns.includes('content'), false);
  assert.equal(state.messageColumns.includes('content_hash'), false);
});

test('daily-discussion restart finds a fourth-page marker and fails closed when the marker page cap is exhausted', async () => {
  let discord = createFakeRiddleDiscord({
    guildId: 'discussion-marker-recover',
    parentId: 'discussion-marker-parent',
    threadId: 'discussion-marker-thread',
  });
  await setGuildFeatureSetting('discussion-marker-recover', 'daily_discussion', {
    enabled: true,
    channelId: 'discussion-marker-parent',
  });
  discord.setNow('2026-09-03T16:00:00.000Z');
  await processDailyDiscussionTick(discord.client, {
    now: new Date('2026-09-03T16:00:00.000Z'),
    hooks: { afterPublishSend: async () => { throw new Error('synthetic discussion publish crash'); } },
  });
  for (let index = 0; index < 300; index += 1) {
    discord.addParentMessage({
      id: `discussion-marker-newer-${String(index).padStart(3, '0')}`,
      userId: `marker-user-${index}`,
      bot: false,
      content: 'newer message',
      createdAt: new Date(Date.parse('2026-09-03T16:00:01.000Z') + index * 1000),
    });
  }
  resetCoinDatabaseForTests();
  await processDailyDiscussionTick(discord.client, {
    now: new Date('2026-09-03T16:06:00.000Z'),
    hooks: { maxMarkerPages: 4 },
  });
  assert.equal([...discord.parentMessages.values()].filter((message) => message.author.bot).length, 1);
  assert.equal(discord.threadStarts, 1);
  assert.equal((await getDailyDiscussionEvent('discussion-marker-recover', '2026-09-04')).status, 'published_late');

  discord = createFakeRiddleDiscord({
    guildId: 'discussion-marker-block',
    parentId: 'discussion-marker-block-parent',
    threadId: 'discussion-marker-block-thread',
  });
  await setGuildFeatureSetting('discussion-marker-block', 'daily_discussion', {
    enabled: true,
    channelId: 'discussion-marker-block-parent',
  });
  discord.setNow('2026-09-03T16:00:00.000Z');
  await processDailyDiscussionTick(discord.client, {
    now: new Date('2026-09-03T16:00:00.000Z'),
    hooks: { afterPublishSend: async () => { throw new Error('synthetic discussion publish crash'); } },
  });
  for (let index = 0; index < 300; index += 1) {
    discord.addParentMessage({
      id: `discussion-marker-cap-${String(index).padStart(3, '0')}`,
      userId: `marker-cap-user-${index}`,
      bot: false,
      content: 'newer message',
      createdAt: new Date(Date.parse('2026-09-03T16:00:01.000Z') + index * 1000),
    });
  }
  await processDailyDiscussionTick(discord.client, {
    now: new Date('2026-09-03T16:06:00.000Z'),
    hooks: { maxMarkerPages: 3 },
  });
  assert.equal((await getDailyDiscussionEvent('discussion-marker-block', '2026-09-04')).status, 'blocked');
  assert.equal([...discord.parentMessages.values()].filter((message) => message.author.bot).length, 1);
  assert.equal(discord.threadStarts, 0);
});

test('daily-discussion blocks incomplete history and disabled coins without any payout', async () => {
  let discord = createFakeRiddleDiscord({
    guildId: 'discussion-history-block',
    parentId: 'discussion-history-parent',
    threadId: 'discussion-history-thread',
  });
  await setGuildFeatureSetting('discussion-history-block', 'daily_discussion', {
    enabled: true,
    channelId: 'discussion-history-parent',
  });
  await processDailyDiscussionTick(discord.client, { now: new Date('2026-09-03T16:00:00.000Z') });
  for (let index = 0; index < 100; index += 1) {
    discord.addHumanMessage({
      id: `discussion-history-${String(index).padStart(3, '0')}`,
      userId: `discussion-history-user-${index}`,
      content: '這是一則有意義的討論內容',
      createdAt: new Date(Date.parse('2026-09-03T17:00:00.000Z') + index * 1000),
    });
  }
  await processDailyDiscussionTick(discord.client, {
    now: new Date('2026-09-04T16:00:00.000Z'),
    hooks: { maxHistoryPages: 1 },
  });
  assert.equal((await getDailyDiscussionEvent('discussion-history-block', '2026-09-04')).status, 'blocked');
  assert.equal(Number(await withCoinDatabase((api) => api.get(
    "SELECT COUNT(*) AS count FROM reward_grants WHERE guild_id = 'discussion-history-block'"
  ).count)), 0);

  discord = createFakeRiddleDiscord({
    guildId: 'discussion-coin-disabled',
    parentId: 'discussion-disabled-parent',
    threadId: 'discussion-disabled-thread',
  });
  await setGuildFeatureSetting('discussion-coin-disabled', 'daily_discussion', {
    enabled: true,
    channelId: 'discussion-disabled-parent',
  });
  await processDailyDiscussionTick(discord.client, { now: new Date('2026-09-03T16:00:00.000Z') });
  discord.addHumanMessage({
    id: 'discussion-disabled-message',
    userId: 'discussion-disabled-user',
    content: '我提出一個完整而且有意義的觀點',
    createdAt: '2026-09-03T18:00:00.000Z',
  });
  await withCoinTransaction((api) => api.run(
    `INSERT INTO coin_guild_settings (guild_id, enabled, created_at, updated_at)
     VALUES (?, 0, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET enabled = 0, updated_at = excluded.updated_at`,
    ['discussion-coin-disabled', '2026-09-04T16:00:00.000Z', '2026-09-04T16:00:00.000Z']
  ));
  await processDailyDiscussionTick(discord.client, { now: new Date('2026-09-04T16:00:00.000Z') });
  assert.equal((await getDailyDiscussionEvent('discussion-coin-disabled', '2026-09-04')).status, 'blocked');
  assert.equal(Number(await withCoinDatabase((api) => api.get(
    "SELECT COUNT(*) AS count FROM reward_grants WHERE guild_id = 'discussion-coin-disabled'"
  ).count)), 0);
});

test('daily-discussion resumes partial rewards and delays the next day until yesterday closes', async () => {
  const discord = createFakeRiddleDiscord({
    guildId: 'discussion-resume',
    parentId: 'discussion-resume-parent',
    threadId: 'discussion-resume-thread',
  });
  await setGuildFeatureSetting('discussion-resume', 'daily_discussion', {
    enabled: true,
    channelId: 'discussion-resume-parent',
  });
  await processDailyDiscussionTick(discord.client, { now: new Date('2026-09-03T16:00:00.000Z') });
  discord.addHumanMessage({
    id: 'discussion-resume-a', userId: 'discussion-resume-user-a', content: '第一位使用者提出完整看法',
    createdAt: '2026-09-03T17:00:00.000Z',
  });
  discord.addHumanMessage({
    id: 'discussion-resume-b', userId: 'discussion-resume-user-b', content: '第二位使用者補充另一種觀點',
    createdAt: '2026-09-03T18:00:00.000Z',
  });
  let crashed = false;
  const cutoff = new Date('2026-09-04T16:00:00.000Z');
  discord.setNow(cutoff);
  const first = await processDailyDiscussionTick(discord.client, {
    now: cutoff,
    hooks: {
      afterRewardGrant: async () => {
        if (!crashed) {
          crashed = true;
          throw new Error('synthetic partial discussion reward crash');
        }
      },
    },
  });
  assert.equal(first.deferred, 1);
  assert.equal((await getDailyDiscussionEvent('discussion-resume', '2026-09-04')).status, 'rewarding');
  assert.equal(await getDailyDiscussionEvent('discussion-resume', '2026-09-05'), null);
  assert.equal(Number(await withCoinDatabase((api) => api.get(
    "SELECT COUNT(*) AS count FROM reward_grants WHERE guild_id = 'discussion-resume'"
  ).count)), 1);

  const resumed = await processDailyDiscussionTick(discord.client, { now: new Date('2026-09-04T16:01:00.000Z') });
  assert.equal(resumed.settled, 1);
  assert.equal(resumed.published, 1);
  assert.equal((await getDailyDiscussionEvent('discussion-resume', '2026-09-04')).status, 'settled');
  assert.equal((await getDailyDiscussionEvent('discussion-resume', '2026-09-05')).status, 'published_late');
  const rewards = await withCoinDatabase((api) => api.all(
    "SELECT user_id, reward_kind, amount FROM reward_grants WHERE guild_id = 'discussion-resume' ORDER BY user_id"
  ));
  assert.deepEqual(rewards, [
    { user_id: 'discussion-resume-user-a', reward_kind: 'participation', amount: 30 },
    { user_id: 'discussion-resume-user-b', reward_kind: 'participation', amount: 30 },
  ]);
});

test('daily-discussion late startup catches up once, crossing midnight cleans side effects, and scheduler is unrefed', async () => {
  let discord = createFakeRiddleDiscord({
    guildId: 'discussion-catchup',
    parentId: 'discussion-catchup-parent',
    threadId: 'discussion-catchup-thread',
  });
  await setGuildFeatureSetting('discussion-catchup', 'daily_discussion', {
    enabled: true,
    channelId: 'discussion-catchup-parent',
    now: new Date('2026-09-03T15:59:00.000Z'),
  });
  const late = await processDailyDiscussionTick(discord.client, { now: new Date('2026-09-03T20:00:00.000Z') });
  assert.equal(late.missed, 1);
  assert.equal(late.published, 1);
  assert.equal((await getDailyDiscussionEvent('discussion-catchup', '2026-09-04')).status, 'published_late');

  discord = createFakeRiddleDiscord({
    guildId: 'discussion-cutoff',
    parentId: 'discussion-cutoff-parent',
    threadId: 'discussion-cutoff-thread',
  });
  await setGuildFeatureSetting('discussion-cutoff', 'daily_discussion', {
    enabled: true,
    channelId: 'discussion-cutoff-parent',
    now: new Date('2026-09-04T15:59:00.000Z'),
  });
  const beforeCutoff = new Date('2026-09-04T15:59:59.000Z');
  const cutoff = new Date('2026-09-04T16:00:00.000Z');
  let clock = beforeCutoff;
  discord.setNow(beforeCutoff);
  await processDailyDiscussionTick(discord.client, {
    now: beforeCutoff,
    hooks: {
      nowFn: () => clock,
      afterThreadCreate: async () => { clock = cutoff; },
    },
  });
  assert.equal(discord.parentMessages.size, 0);
  assert.equal(discord.parentDeletes, 1);
  assert.equal(discord.threadDeletes, 1);
  assert.equal((await getDailyDiscussionEvent('discussion-cutoff', '2026-09-04')).status, 'missed');

  stopDailyDiscussionScheduler();
  assert.equal(getNextDiscussionBoundaryDelay(new Date('2026-09-04T15:59:31.000Z')), 29_000);
  let timeoutUnref = false;
  let intervalUnref = false;
  let timeoutCallback;
  let ticks = 0;
  const timers = await startDailyDiscussionScheduler(discord.client, {
    nowFn: () => new Date('2026-09-04T15:59:31.000Z'),
    tick: async () => { ticks += 1; },
    setTimeoutFn: (callback) => {
      timeoutCallback = callback;
      return { unref: () => { timeoutUnref = true; } };
    },
    setIntervalFn: () => ({ unref: () => { intervalUnref = true; } }),
  });
  assert.equal(ticks, 1);
  assert.equal(timeoutUnref, true);
  assert.equal(intervalUnref, true);
  timeoutCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ticks, 2);
  let clearedTimeout;
  let clearedInterval;
  assert.equal(stopDailyDiscussionScheduler({
    clearTimeoutFn: (value) => { clearedTimeout = value; },
    clearIntervalFn: (value) => { clearedInterval = value; },
  }), true);
  assert.equal(clearedTimeout, timers.boundaryTimer);
  assert.equal(clearedInterval, timers.watchdogTimer);
});
