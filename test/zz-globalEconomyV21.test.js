const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-global-economy-v21-'));
process.env.COIN_TIMEZONE = 'Asia/Taipei';

const coinDatabase = require('../src/services/coinDatabase');
const {
  CoinServiceError,
  ShopItemTypes,
  adjustPlayerBalance,
  createShopItem,
  dailyCheckin,
  getInventory,
  getPlayerBalance,
  getShopItem,
  purchaseItem,
} = require('../src/services/coinService');
const {
  createLuxuryItem,
  getLuxuryInventory,
  purchaseLuxuryItem,
} = require('../src/services/luxuryService');
const { enterDuelTower, listOwnedBattleWeapons } = require('../src/services/casinoFacilityService');
const { standBlackjack, startBlackjack } = require('../src/services/casinoService');
const {
  getDebtWithApi,
  mutateWalletWithApi,
  setDebtWithApi,
} = require('../src/services/coinWalletService');
const {
  ChipLedgerType,
  creditChipsWithApi,
  getChipBalance,
} = require('../src/services/chipService');
const shopAdminCommand = require('../src/commands/shop-admin');
const luxuryAdminCommand = require('../src/commands/luxury-admin');

async function freshDatabase(name) {
  coinDatabase.resetCoinDatabaseForTests();
  const directory = path.join(tempRoot, name);
  fs.mkdirSync(directory, { recursive: true });
  const dbPath = path.join(directory, 'xiaoji.sqlite');
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
  process.env.COIN_DB_PATH = dbPath;
  await coinDatabase.initializeNewCoinDatabase({ expectedPath: dbPath });
  return { directory, dbPath };
}

async function readSqlite(dbPath, callback) {
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(path.dirname(require.resolve('sql.js')), fileName) });
  const db = new SQL.Database(fs.readFileSync(dbPath));
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function one(db, sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    return statement.step() ? statement.getAsObject() : null;
  } finally {
    statement.free();
  }
}

function saveSqlite(dbPath, db) {
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
}

async function downgradeEconomyTargetsToV20(dbPath) {
  await readSqlite(dbPath, (db) => {
    db.exec('PRAGMA foreign_keys = OFF;');
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
    db.exec(`
      UPDATE coin_metadata SET value = '20' WHERE key = 'schema_version';
      DROP TABLE coin_daily_state;
      DROP TABLE coin_daily_checkins_global;
      DROP TABLE coin_debts;
      DROP TABLE coin_global_inventory;
      DROP TABLE coin_global_purchases;
      DROP TABLE coin_global_shop_items;
      DROP TABLE luxury_global_pawn_redemptions;
      DROP TABLE luxury_global_pawn_records;
      DROP TABLE luxury_global_inventory;
      DROP TABLE luxury_global_purchases;
      DROP TABLE luxury_global_price_history;
      DROP TABLE luxury_global_items;
    `);
    saveSqlite(dbPath, db);
  });
}

test.after(() => {
  coinDatabase.resetCoinDatabaseForTests();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('v21 migrates legacy daily history into one global streak and rejects cross-guild duplicates', async () => {
  const { dbPath } = await freshDatabase('daily-migration');
  await Promise.all([
    getPlayerBalance('guild-a', 'daily-user'),
    getPlayerBalance('guild-b', 'daily-user'),
  ]);
  await coinDatabase.withCoinTransaction((api) => {
    for (const row of [
      ['guild-a', 'daily-user', '2026-12-29', 50, 0, 1, '2026-12-29T01:00:00.000Z'],
      ['guild-b', 'daily-user', '2026-12-29', 80, 30, 1, '2026-12-29T02:00:00.000Z'],
      ['guild-b', 'daily-user', '2026-12-30', 50, 0, 1, '2026-12-30T01:00:00.000Z'],
      ['guild-a', 'daily-user', '2026-12-31', 50, 0, 1, '2026-12-31T01:00:00.000Z'],
    ]) {
      api.run(`INSERT INTO coin_daily_checkins
        (guild_id, user_id, checkin_date, earned_amount, bonus_amount, streak, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, row);
    }
  });
  coinDatabase.resetCoinDatabaseForTests();
  await downgradeEconomyTargetsToV20(dbPath);

  const migrated = await coinDatabase.initializeCoinDatabase();
  assert.equal(migrated.schemaVersion, 22);
  const state = await coinDatabase.withCoinDatabase((api) => ({
    rows: api.all('SELECT checkin_date, source_guild_id, streak FROM coin_daily_checkins_global WHERE user_id = ? ORDER BY checkin_date', ['daily-user']),
    state: api.get('SELECT * FROM coin_daily_state WHERE user_id = ?', ['daily-user']),
  }));
  assert.deepEqual(state.rows, [
    { checkin_date: '2026-12-29', source_guild_id: 'guild-a', streak: 1 },
    { checkin_date: '2026-12-30', source_guild_id: 'guild-b', streak: 2 },
    { checkin_date: '2026-12-31', source_guild_id: 'guild-a', streak: 3 },
  ]);
  assert.equal(state.state.last_checkin_date, '2026-12-31');
  assert.equal(state.state.streak, 3);

  const results = await Promise.allSettled([
    dailyCheckin('guild-a', 'parallel-user', new Date('2026-12-31T16:30:00.000Z')),
    dailyCheckin('guild-b', 'parallel-user', new Date('2026-12-31T16:30:00.000Z')),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected').reason;
  assert.equal(rejected.code, 'ALREADY_CHECKED_IN');
  assert.equal(rejected.message, '今日已簽到過，請等待1月2日00點00分（台灣時間）再簽到一次。');
  coinDatabase.resetCoinDatabaseForTests();
  await coinDatabase.initializeCoinDatabase();
  const player = await getPlayerBalance('guild-b', 'parallel-user');
  assert.equal(player.lastDailyDate, '2027-01-01');
  assert.equal(player.dailyStreak, 1);
});

test('daily authority and v21 migration always use Taipei dates despite environment and host timezones', async () => {
  const originalCoinTimezone = process.env.COIN_TIMEZONE;
  const originalHostTimezone = process.env.TZ;
  process.env.COIN_TIMEZONE = 'UTC';
  process.env.TZ = 'America/Los_Angeles';
  try {
    const { dbPath } = await freshDatabase('daily-fixed-taipei');
    await Promise.all([
      getPlayerBalance('guild-a', 'utc-daily-user'),
      getPlayerBalance('guild-b', 'utc-daily-user'),
    ]);
    await coinDatabase.withCoinTransaction((api) => {
      for (const row of [
        ['guild-a', 'utc-daily-user', '2026-12-31', 50, 0, 1, '2026-12-31 16:30:00'],
        ['guild-b', 'utc-daily-user', '2027-01-01', 80, 30, 1, '2026-12-31T17:00:00.000Z'],
      ]) {
        api.run(`INSERT INTO coin_daily_checkins
          (guild_id, user_id, checkin_date, earned_amount, bonus_amount, streak, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, row);
      }
    });
    coinDatabase.resetCoinDatabaseForTests();
    await downgradeEconomyTargetsToV20(dbPath);
    await coinDatabase.initializeCoinDatabase();

    const migrated = await coinDatabase.withCoinDatabase((api) => ({
      rows: api.all(
        'SELECT checkin_date, source_guild_id, streak FROM coin_daily_checkins_global WHERE user_id = ? ORDER BY checkin_date',
        ['utc-daily-user']
      ),
      state: api.get('SELECT last_checkin_date, streak FROM coin_daily_state WHERE user_id = ?', ['utc-daily-user']),
    }));
    assert.deepEqual(migrated.rows, [
      { checkin_date: '2027-01-01', source_guild_id: 'guild-a', streak: 1 },
    ]);
    assert.deepEqual(migrated.state, { last_checkin_date: '2027-01-01', streak: 1 });

    await assert.rejects(
      () => dailyCheckin('guild-b', 'utc-daily-user', new Date('2027-01-01T15:59:59.000Z')),
      (error) => error instanceof CoinServiceError &&
        error.code === 'ALREADY_CHECKED_IN' &&
        error.message === '今日已簽到過，請等待1月2日00點00分（台灣時間）再簽到一次。'
    );
    const nextDay = await dailyCheckin('guild-b', 'utc-daily-user', new Date('2027-01-01T16:00:00.000Z'));
    assert.equal(nextDay.checkinDate, '2027-01-02');
    assert.equal(nextDay.streak, 2);
    assert.equal(nextDay.nextDailyAt, '1月3日00點00分（台灣時間）');
  } finally {
    if (originalCoinTimezone === undefined) delete process.env.COIN_TIMEZONE;
    else process.env.COIN_TIMEZONE = originalCoinTimezone;
    if (originalHostTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalHostTimezone;
  }
});

test('v21 migration rejects ambiguous legacy daily timestamps without inventing a date', async () => {
  const { dbPath } = await freshDatabase('daily-invalid-timestamp');
  await getPlayerBalance('guild-a', 'invalid-daily-user');
  await coinDatabase.withCoinTransaction((api) => {
    api.run(`INSERT INTO coin_daily_checkins
      (guild_id, user_id, checkin_date, earned_amount, bonus_amount, streak, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['guild-a', 'invalid-daily-user', '2026-12-31', 50, 0, 1, '2026-12-31T16:30:00']);
  });
  coinDatabase.resetCoinDatabaseForTests();
  await downgradeEconomyTargetsToV20(dbPath);
  await assert.rejects(
    () => coinDatabase.initializeCoinDatabase(),
    (error) => error?.cause?.message === 'legacy daily check-in contains an invalid UTC timestamp'
  );
  coinDatabase.resetCoinDatabaseForTests();
});

test('global catalogs share stock, limits, inventory, and duel item lookup while rejecting legacy ids and role items', async () => {
  await freshDatabase('global-catalogs');
  await adjustPlayerBalance('guild-a', 'buyer', { action: 'set', amount: 2000, operatorId: 'owner', reason: 'test' });
  const item = await createShopItem('guild-a', {
    name: '全球徽章', price: 100, type: ShopItemTypes.COLLECTIBLE, stock: 1, purchaseLimit: 1, createdBy: 'owner',
  });
  assert.match(item.id, /^g_[0-9a-f-]{36}$/i);
  assert.equal((await getShopItem('guild-b', item.id)).id, item.id);
  assert.equal(await getShopItem('guild-a', '1'), null);
  await assert.rejects(
    () => createShopItem('guild-a', { name: '舊式角色', price: 1, type: ShopItemTypes.ROLE, roleId: 'role', createdBy: 'owner' }),
    (error) => error instanceof CoinServiceError && error.code === 'ROLE_ITEM_NOT_SUPPORTED'
  );
  const race = await Promise.allSettled([
    purchaseItem('guild-a', 'buyer', item.id, 1),
    purchaseItem('guild-b', 'buyer', item.id, 1),
  ]);
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await getInventory('guild-a', 'buyer')).length, 1);
  assert.equal((await getInventory('guild-b', 'buyer')).length, 1);

  const weapon = await createShopItem('guild-a', {
    name: '全球對戰道具', price: 50, type: ShopItemTypes.BATTLE_ITEM, stock: 2, purchaseLimit: 2, createdBy: 'owner',
  });
  await purchaseItem('guild-b', 'buyer', weapon.id, 1);
  assert.deepEqual((await listOwnedBattleWeapons('guild-a', 'buyer')).map((row) => row.itemId), [weapon.id]);

  const luxury = await createLuxuryItem('guild-a', {
    name: '全球手錶', price: 200, stock: 1, purchaseLimit: 1, createdBy: 'owner',
  });
  assert.match(luxury.id, /^l_[0-9a-f-]{36}$/i);
  await purchaseLuxuryItem('guild-b', 'buyer', luxury.id, 1);
  assert.equal((await getLuxuryInventory('guild-a', 'buyer')).items.length, 1);
  assert.equal((await getLuxuryInventory('guild-b', 'buyer')).items.length, 1);
  await assert.rejects(() => purchaseLuxuryItem('guild-a', 'buyer', '1', 1), { code: 'LUXURY_ITEM_NOT_FOUND' });
});

test('shop administration commands are bot-owner only even for a guild administrator', async () => {
  const previousOwner = process.env.BOT_OWNER_ID;
  process.env.BOT_OWNER_ID = 'owner-user';
  const replies = [];
  const interaction = {
    commandName: 'shop-admin',
    inGuild: () => true,
    user: { id: 'guild-admin', tag: 'guild-admin' },
    reply: async (payload) => replies.push(payload),
    replied: false,
    deferred: false,
  };
  try {
    await shopAdminCommand.execute(interaction);
    await luxuryAdminCommand.execute({ ...interaction, commandName: 'luxury-admin' });
    assert.deepEqual(replies.map((entry) => entry.content), [
      '你沒有權限使用這個指令。',
      '你沒有權限使用這個指令。',
    ]);
  } finally {
    if (previousOwner === undefined) delete process.env.BOT_OWNER_ID;
    else process.env.BOT_OWNER_ID = previousOwner;
  }
});

test('generic debt offsets only allowlisted income and records gross, offset, and net atomically', async () => {
  await freshDatabase('debt-offset');
  await getPlayerBalance('guild-a', 'debtor');
  await coinDatabase.withCoinTransaction((api) => setDebtWithApi(api, 'debtor', 120, '2026-09-22T00:00:00.000Z'));
  await coinDatabase.withCoinTransaction((api) => mutateWalletWithApi(api, {
    guildId: 'guild-a', userId: 'debtor', type: 'system_refund', balanceDelta: 50,
    totalSpentTarget: 0, reason: 'refund exempt', createdAt: '2026-09-22T00:01:00.000Z',
  }));
  let player = await getPlayerBalance('guild-a', 'debtor');
  assert.equal(player.balance, 50);
  assert.equal(player.debtAmount, 120);

  const salary = await coinDatabase.withCoinTransaction((api) => mutateWalletWithApi(api, {
    guildId: 'guild-a', userId: 'debtor', type: 'work_salary', balanceDelta: 100,
    totalEarnedDelta: 100, reason: 'salary', createdAt: '2026-09-22T00:02:00.000Z',
  }));
  assert.deepEqual({ gross: salary.grossAmount, offset: salary.debtOffset, net: salary.netAmount }, {
    gross: 100, offset: 100, net: 0,
  });
  player = await getPlayerBalance('guild-b', 'debtor');
  assert.equal(player.balance, 50);
  assert.equal(player.debtAmount, 20);

  await coinDatabase.withCoinTransaction((api) => mutateWalletWithApi(api, {
    guildId: 'guild-b', userId: 'debtor', type: 'system_reward', balanceDelta: 30,
    totalEarnedDelta: 30, reason: 'game reward', createdAt: '2026-09-22T00:03:00.000Z',
  }));
  await coinDatabase.withCoinTransaction((api) => setDebtWithApi(api, 'debtor', 50, '2026-09-22T00:04:00.000Z'));
  await coinDatabase.withCoinTransaction((api) => mutateWalletWithApi(api, {
    guildId: 'guild-b', userId: 'debtor', type: 'chip_cashout', balanceDelta: 20,
    reason: 'chip principal exempt', createdAt: '2026-09-22T00:05:00.000Z',
  }));
  player = await getPlayerBalance('guild-a', 'debtor');
  assert.equal(player.balance, 80);
  assert.equal(player.debtAmount, 50);
  await coinDatabase.withCoinTransaction((api) => creditChipsWithApi(api, 'guild-a', 'debtor', 20, {
    entryType: ChipLedgerType.TIP_PAYOUT,
    reason: 'tip income',
    timestamp: '2026-09-22T00:06:00.000Z',
  }));
  await coinDatabase.withCoinTransaction((api) => creditChipsWithApi(api, 'guild-a', 'debtor', 10, {
    entryType: ChipLedgerType.TIP_REFUND,
    reason: 'tip refund exempt',
    timestamp: '2026-09-22T00:07:00.000Z',
  }));
  const gamePayout = await coinDatabase.withCoinTransaction((api) => creditChipsWithApi(api, 'guild-b', 'debtor', 40, {
    entryType: ChipLedgerType.PAYOUT,
    debtOffsetAmount: 10,
    reason: 'game payout',
    timestamp: '2026-09-22T00:08:00.000Z',
  }));
  assert.deepEqual({ gross: gamePayout.grossAmount, offset: gamePayout.debtOffset, net: gamePayout.netAmount }, {
    gross: 40, offset: 10, net: 30,
  });
  assert.equal((await getChipBalance('guild-a', 'debtor')).balance, 40);
  assert.equal((await getChipBalance('guild-b', 'debtor')).balance, 40);
  player = await getPlayerBalance('guild-a', 'debtor');
  assert.equal(player.debtAmount, 20);
  const transaction = await coinDatabase.withCoinDatabase((api) => api.get(
    "SELECT metadata FROM coin_transactions WHERE type = 'work_salary' AND user_id = 'debtor'"
  ));
  assert.deepEqual(JSON.parse(transaction.metadata).debtOffset, {
    gross: 100, offset: 100, net: 0, debtBefore: 120, debtAfter: 20,
  });
  const chipLedger = await coinDatabase.withCoinDatabase((api) => api.get(
    "SELECT metadata FROM chip_ledger WHERE entry_type = 'payout' AND user_id = 'debtor'"
  ));
  assert.deepEqual(JSON.parse(chipLedger.metadata).debtOffset, {
    gross: 40, eligibleIncome: 10, offset: 10, net: 30, debtBefore: 30, debtAfter: 20,
  });
});

test('casino debt offset preserves duel and blackjack principal across draw, win, and restart', async () => {
  await freshDatabase('casino-principal');
  await adjustPlayerBalance('guild-a', 'duelist', { action: 'set', amount: 1000, operatorId: 'owner', reason: 'fixture' });
  const weapon = await createShopItem('guild-a', {
    name: '本金測試劍', price: 50, type: ShopItemTypes.BATTLE_ITEM, stock: 1, purchaseLimit: 1, createdBy: 'owner',
  });
  await purchaseItem('guild-a', 'duelist', weapon.id, 1);
  await coinDatabase.withCoinTransaction((api) => {
    creditChipsWithApi(api, 'guild-a', 'duelist', 300, { entryType: ChipLedgerType.REFUND, reason: 'fixture' });
    setDebtWithApi(api, 'duelist', 100, '2026-09-22T01:00:00.000Z');
  });
  const drawValues = [6, 0];
  const draw = await enterDuelTower('guild-a', 'duelist', {
    weaponItemId: weapon.id,
    wager: 50,
    rng: () => drawValues.shift(),
  });
  assert.equal(draw.run.status, 'draw');
  assert.equal((await getChipBalance('guild-a', 'duelist')).balance, 300);
  assert.equal((await getPlayerBalance('guild-a', 'duelist')).debtAmount, 100);

  const winValues = [59, 0];
  const win = await enterDuelTower('guild-a', 'duelist', {
    weaponItemId: weapon.id,
    wager: 50,
    rng: () => winValues.shift(),
  });
  assert.equal(win.run.status, 'win');
  assert.equal((await getChipBalance('guild-a', 'duelist')).balance, 300);
  assert.equal((await getPlayerBalance('guild-a', 'duelist')).debtAmount, 50);

  await coinDatabase.withCoinTransaction((api) => {
    creditChipsWithApi(api, 'guild-a', 'blackjack-user', 300, { entryType: ChipLedgerType.REFUND, reason: 'fixture' });
    setDebtWithApi(api, 'blackjack-user', 80, '2026-09-22T01:10:00.000Z');
  });
  const started = await startBlackjack('guild-a', 'blackjack-user', {
    amount: 100,
    deck: ['10S', '8H', '9C', '9D'],
    date: new Date('2026-09-22T01:11:00.000Z'),
  });
  assert.equal(started.session.status, 'active');
  coinDatabase.resetCoinDatabaseForTests();
  await coinDatabase.initializeCoinDatabase();
  const settled = await standBlackjack('guild-a', 'blackjack-user', started.session.id, {
    date: new Date('2026-09-22T01:12:00.000Z'),
  });
  assert.equal(settled.result.outcome, 'push');
  assert.equal((await getChipBalance('guild-a', 'blackjack-user')).balance, 300);
  assert.equal((await getPlayerBalance('guild-a', 'blackjack-user')).debtAmount, 80);
  const payoutLedger = await coinDatabase.withCoinDatabase((api) => api.get(
    "SELECT metadata FROM chip_ledger WHERE user_id = 'blackjack-user' AND entry_type = 'payout' ORDER BY id DESC LIMIT 1"
  ));
  const metadata = JSON.parse(payoutLedger.metadata);
  assert.deepEqual({
    sessionId: metadata.blackjackSessionId,
    betAmount: metadata.betAmount,
    payoutAmount: metadata.payoutAmount,
    eligibleIncome: metadata.eligibleIncome,
    outcome: metadata.result.outcome,
  }, {
    sessionId: started.session.id,
    betAmount: 100,
    payoutAmount: 100,
    eligibleIncome: 0,
    outcome: 'push',
  });
});
