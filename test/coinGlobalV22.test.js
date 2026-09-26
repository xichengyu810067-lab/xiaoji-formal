const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const {
  dryRunGlobalEconomyV22, getCoinDatabaseInfo, initializeCoinDatabase,
  initializeNewCoinDatabase, resetCoinDatabaseForTests, withCoinDatabase, withCoinTransaction,
} = require('../src/services/coinDatabase');
const { adjustPlayerBalance, getPlayerBalance } = require('../src/services/coinService');
const { deposit, withdraw, getBalanceSummary, getInterestDate, processBankInterest,
  claimFixedDeposit, cancelFixedDeposit } = require('../src/services/bankService');
const { buyChips, cashoutChips, getChipBalance } = require('../src/services/chipService');
const { grantRewardOnceV2, getRewardReceiptV2, makeRewardKey } = require('../src/services/featurePlatformService');
const { previewOwnerCampaign, applyOwnerCampaign, importOwnerCampaignHistory,
  classifyOwnerCampaignHistoryRecord, getOwnerCampaignHistoryReviewPlan,
  reviewOwnerCampaignHistory } = require('../src/services/coinCampaignService');
const { mutateWalletWithApi } = require('../src/services/coinWalletService');
const { borrowCasinoLoan, getCasinoLoanStatus, repayCasinoLoan } = require('../src/services/casinoService');
const coinAdminCommand = require('../src/commands/coin-admin');

let fixtureDir;
let dbPath;
let originalOwnerId;

test.beforeEach(() => {
  originalOwnerId = process.env.BOT_OWNER_ID;
  process.env.BOT_OWNER_ID = 'owner';
  resetCoinDatabaseForTests({ allowCreateOnNextOpen: true });
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-v22-fixture-'));
  dbPath = path.join(fixtureDir, 'coin.sqlite');
  process.env.COIN_DB_PATH = dbPath;
});

test.afterEach(() => {
  resetCoinDatabaseForTests();
  delete process.env.COIN_DB_PATH;
  delete process.env.COIN_V22_EXPECTED_SOURCE_SHA256;
  if (originalOwnerId === undefined) delete process.env.BOT_OWNER_ID;
  else process.env.BOT_OWNER_ID = originalOwnerId;
  if (fixtureDir && fixtureDir.startsWith(os.tmpdir())) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

async function reviewCampaignUsers(campaignId, userIds, priorGrantUserIds = []) {
  const plan = await getOwnerCampaignHistoryReviewPlan({ campaignId, userIds, actorUserId: 'owner' });
  return reviewOwnerCampaignHistory({ campaignId, actorUserId: 'owner',
    reviewId: crypto.createHash('sha256')
      .update(`synthetic-review:${campaignId}:${userIds.join(',')}:${plan.sourceSha256}`).digest('hex'),
    sourceSha256: plan.sourceSha256,
    decisions: userIds.map((userId) => ({
      userId, priorGrant: priorGrantUserIds.includes(userId),
      reviewedTransactionIds: plan.transactions.filter((row) => row.user_id === userId).map((row) => row.id),
      reviewedLegacyGrantIds: plan.legacyGrants.filter((row) => row.user_id === userId).map((row) => row.id),
      reviewedAdminLogIds: plan.adminLogs.filter((row) => row.target_user_id === userId).map((row) => row.id),
      reviewReason: 'synthetic source inventory reviewed',
    })) });
}

async function runCampaignCommand(subcommand, options, members) {
  let message;
  const interaction = {
    id: `synthetic-${subcommand}-${crypto.randomUUID()}`,
    commandName: 'coin-admin', guildId: 'guild-a',
    guild: { memberCount: members.size, members: { fetch: async () => members } },
    user: { id: 'owner', tag: 'owner' }, inGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getRole: () => options.role || null,
      getUser: () => options.user ? { id: options.user } : null,
    },
    deferred: false, replied: false,
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (text) => { message = text; },
    reply: async ({ content }) => { message = content; },
  };
  await coinAdminCommand.execute(interaction);
  return message;
}

test('configured missing database fails closed; explicit first install creates once and reopens', async () => {
  resetCoinDatabaseForTests();
  assert.equal(fs.existsSync(dbPath), false);
  await assert.rejects(initializeCoinDatabase(), /不存在/);
  assert.equal(fs.existsSync(dbPath), false);
  assert.equal((await initializeNewCoinDatabase({ expectedPath: dbPath })).createdDatabase, true);
  const created = fs.readFileSync(dbPath);
  await assert.rejects(initializeNewCoinDatabase({ expectedPath: dbPath }), /初裝初始化/);
  assert.deepEqual(fs.readFileSync(dbPath), created);
  resetCoinDatabaseForTests();
  assert.equal((await initializeCoinDatabase()).createdDatabase, false);
  resetCoinDatabaseForTests();
  fs.unlinkSync(dbPath);
  await assert.rejects(initializeCoinDatabase(), /不存在/);
  assert.equal(fs.existsSync(dbPath), false);
});

test('empty and corrupt configured database bytes never trigger an empty replacement', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('not a SQLite database')]) {
    resetCoinDatabaseForTests();
    fs.writeFileSync(dbPath, bytes);
    await assert.rejects(initializeCoinDatabase(), /讀取失敗/);
    assert.deepEqual(fs.readFileSync(dbPath), bytes);
  }
});

test('explicit first-install command creates once and never overwrites an existing database', () => {
  resetCoinDatabaseForTests();
  const script = path.join(__dirname, '..', 'scripts', 'init-coin-db.js');
  const env = { ...process.env, COIN_DB_PATH: dbPath };
  const created = spawnSync(process.execPath, [script, dbPath], { env, encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const bytes = fs.readFileSync(dbPath);
  const repeated = spawnSync(process.execPath, [script, dbPath], { env, encoding: 'utf8' });
  assert.notEqual(repeated.status, 0);
  assert.deepEqual(fs.readFileSync(dbPath), bytes);
});

test('bank and chips remain user-owned across source guilds without counting conversions as earnings', async () => {
  await adjustPlayerBalance('guild-a', 'user-1', { action: 'add', amount: 2000, operatorId: 'owner', reason: 'fixture' });
  await deposit('guild-a', 'user-1', 1000);
  assert.equal((await getBalanceSummary('guild-b', 'user-1')).bankBalance, 1000);
  await withdraw('guild-b', 'user-1', 200);
  await buyChips('guild-a', 'user-1', 300);
  assert.equal((await getChipBalance('guild-b', 'user-1')).balance, 300);
  const cashout = await cashoutChips('guild-b', 'user-1', 300);
  assert.equal(cashout.fee, 100);
  assert.equal((await getChipBalance('guild-a', 'user-1')).balance, 0);
  const wallet = await getPlayerBalance('guild-b', 'user-1');
  assert.equal(wallet.totalEarned, 2000);
  assert.equal(wallet.totalSpent, 0);
});

test('demand interest offsets debt exactly once while bank principal stays owned by the user', async () => {
  await adjustPlayerBalance('guild-a', 'user-1', { action: 'add', amount: 10000,
    operatorId: 'owner', reason: 'synthetic bank principal' });
  await deposit('guild-a', 'user-1', 10000);
  const now = new Date();
  const taipeiHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei',
    hour: '2-digit', hourCycle: 'h23' }).format(now));
  const today = getInterestDate(now);
  const priorDate = new Date(Date.parse(`${today}T00:00:00Z`) -
    (taipeiHour >= 23 ? 1 : 2) * 86400000).toISOString().slice(0, 10);
  await withCoinTransaction((api) => {
    api.run(`INSERT INTO coin_debts (user_id, amount, created_at, updated_at)
      VALUES ('user-1', 5, '2026-09-26', '2026-09-26')`);
    api.run('UPDATE coin_bank_accounts_global SET last_interest_date = ? WHERE user_id = ?',
      [priorDate, 'user-1']);
  });
  assert.equal((await processBankInterest()).processed, 1);
  assert.equal((await getPlayerBalance('guild-b', 'user-1')).balance, 0);
  assert.equal((await getBalanceSummary('guild-b', 'user-1')).bankBalance, 10000);
  assert.equal(await withCoinDatabase((api) => api.get('SELECT amount FROM coin_debts WHERE user_id = ?',
    ['user-1']).amount), 3);
  assert.equal((await processBankInterest()).processed, 0);
});

test('matured fixed principal returns intact and only interest offsets debt', async () => {
  await getPlayerBalance('guild-a', 'user-1');
  const maturityAt = new Date(Date.now() - 86400000).toISOString();
  const createdAt = new Date(Date.now() - 8 * 86400000).toISOString();
  const fixedId = await withCoinTransaction((api) => {
    api.run(`INSERT INTO coin_debts (user_id, amount, created_at, updated_at)
      VALUES ('user-1', 5, '2026-09-26', '2026-09-26')`);
    api.run(`INSERT INTO coin_fixed_deposits
      (guild_id,user_id,principal,term_days,rate,expected_interest,source,status,created_at,maturity_at)
      VALUES ('guild-a','user-1',1000,7,0.0035,3,'wallet','active',?,?)`,
    [createdAt, maturityAt]);
    return Number(api.get('SELECT last_insert_rowid() AS id').id);
  });
  const claimed = await claimFixedDeposit('guild-b', 'user-1', fixedId);
  assert.equal(claimed.grossAmount, 1003);
  assert.equal(claimed.paidAmount, 1000);
  assert.equal(claimed.debtOffset, 3);
  assert.equal(claimed.walletAfter, 1000);
  assert.equal(await withCoinDatabase((api) => api.get('SELECT amount FROM coin_debts WHERE user_id = ?',
    ['user-1']).amount), 2);
  await assert.rejects(claimFixedDeposit('guild-a', 'user-1', fixedId),
    { code: 'FIXED_DEPOSIT_ALREADY_CLAIMED' });
  assert.equal((await getPlayerBalance('guild-a', 'user-1')).balance, 1000);
});

test('early fixed cancellation returns principal intact and offsets debt from earned interest only', async () => {
  await getPlayerBalance('guild-a', 'user-1');
  const createdAt = new Date(Date.now() - 10 * 86400000).toISOString();
  const maturityAt = new Date(Date.now() + 5 * 86400000).toISOString();
  const fixedId = await withCoinTransaction((api) => {
    api.run(`INSERT INTO coin_debts (user_id, amount, created_at, updated_at)
      VALUES ('user-1', 5, '2026-09-26', '2026-09-26')`);
    api.run(`INSERT INTO coin_fixed_deposits
      (guild_id,user_id,principal,term_days,rate,expected_interest,source,status,created_at,maturity_at)
      VALUES ('guild-a','user-1',1000,15,0.01,10,'wallet','active',?,?)`,
    [createdAt, maturityAt]);
    return Number(api.get('SELECT last_insert_rowid() AS id').id);
  });
  const cancelled = await cancelFixedDeposit('guild-b', 'user-1', fixedId);
  assert.equal(cancelled.grossAmount, 1003);
  assert.equal(cancelled.paidAmount, 1000);
  assert.equal(cancelled.interestPaid, 3);
  assert.equal(cancelled.debtOffset, 3);
  assert.equal(cancelled.walletAfter, 1000);
  assert.equal(await withCoinDatabase((api) => api.get('SELECT amount FROM coin_debts WHERE user_id = ?',
    ['user-1']).amount), 2);
  await assert.rejects(cancelFixedDeposit('guild-a', 'user-1', fixedId),
    { code: 'FIXED_DEPOSIT_CANCELLED' });
});

test('reward key is global, debt offset is stable on retry, and a changed amount conflicts', async () => {
  await getPlayerBalance('guild-a', 'user-1');
  await withCoinTransaction((api) => api.run(`INSERT INTO coin_debts
    (user_id, amount, created_at, updated_at) VALUES ('user-1', 40, '2026-09-26', '2026-09-26')`));
  const input = { kind: 'game', canonicalSourceId: 'discord:synthetic-session',
    rewardKind: 'completion', userId: 'user-1', sourceGuildId: 'guild-a', amount: 100 };
  const first = await grantRewardOnceV2(input);
  const second = await grantRewardOnceV2({ ...input, sourceGuildId: 'guild-b' });
  assert.equal(first.alreadyGranted, false);
  assert.equal(first.debtOffset, 40);
  assert.equal(first.netAmount, 60);
  assert.equal(second.alreadyGranted, true);
  assert.equal(second.receipt.transactionId, first.receipt.transactionId);
  assert.equal(second.debtOffset, 40);
  assert.equal((await getPlayerBalance('guild-b', 'user-1')).balance, 60);
  const key = makeRewardKey(input);
  assert.equal((await getRewardReceiptV2({ rewardKey: key })).amount, 100);
  await assert.rejects(grantRewardOnceV2({ ...input, amount: 101 }), { code: 'REWARD_KEY_CONFLICT' });
});

test('one outstanding loan remains accessible and repayable across source guilds', async () => {
  await adjustPlayerBalance('guild-a', 'user-1', { action: 'add', amount: 1000,
    operatorId: 'owner', reason: 'synthetic loan reserve' });
  const date = new Date('2026-09-26T00:00:00.000Z');
  const borrowed = await borrowCasinoLoan('guild-a', 'user-1', { amount: 200, date });
  const across = await getCasinoLoanStatus('guild-b', 'user-1', { date });
  assert.equal(across.loan.id, borrowed.loan.id);
  assert.equal(across.loan.currentDebtAmount, 200);
  const repaid = await repayCasinoLoan('guild-b', 'user-1', { amount: 200, date });
  assert.equal(repaid.loan.currentDebtAmount, 0);
  assert.equal((await getCasinoLoanStatus('guild-a', 'user-1', { date })).loan, null);
});

test('owner campaign snapshots resume only unpaid members and share one key across guilds', async () => {
  const base = { campaignId: 'synthetic-campaign', sourceGuildId: 'guild-a',
    audienceType: 'member', amount: 50, reason: 'synthetic', actorUserId: 'owner' };
  const first = await previewOwnerCampaign({ ...base, memberIds: ['user-1', 'user-2'] });
  assert.equal(first.pending, 2);
  assert.equal(first.historyUnreviewed, 2);
  await assert.rejects(applyOwnerCampaign({ ...base, previewToken: first.previewToken,
    presentMemberIds: ['user-1', 'user-2'] }), { code: 'CAMPAIGN_HISTORY_UNRECONCILED' });
  await reviewCampaignUsers(base.campaignId, ['user-1', 'user-2']);
  const partial = await applyOwnerCampaign({ ...base, previewToken: first.previewToken, presentMemberIds: ['user-1'] });
  assert.equal(partial.granted, 1);
  assert.deepEqual(partial.leftGuild, ['user-2']);
  const resumed = await applyOwnerCampaign({ ...base, previewToken: first.previewToken,
    presentMemberIds: ['user-1', 'user-2'] });
  assert.equal(resumed.granted, 1);
  assert.equal(resumed.alreadyGranted, 1);
  const otherGuild = await previewOwnerCampaign({ ...base, sourceGuildId: 'guild-b',
    memberIds: ['user-1', 'user-3'] });
  await assert.rejects(applyOwnerCampaign({ ...base, sourceGuildId: 'guild-b',
    previewToken: otherGuild.previewToken, presentMemberIds: ['user-1', 'user-3'] }),
  { code: 'CAMPAIGN_HISTORY_UNRECONCILED' });
  await reviewCampaignUsers(base.campaignId, ['user-3']);
  const second = await applyOwnerCampaign({ ...base, sourceGuildId: 'guild-b',
    previewToken: otherGuild.previewToken, presentMemberIds: ['user-1', 'user-3'] });
  assert.equal(second.granted, 1);
  assert.equal(second.alreadyGranted, 1);
  assert.equal((await getPlayerBalance('guild-b', 'user-1')).balance, 50);
  assert.equal((await getPlayerBalance('guild-b', 'user-3')).balance, 50);
});

test('an unresolved recipient stays blocked while reviewed recipients can be issued and resumed', async () => {
  const base = { campaignId: 'synthetic-partial-history', sourceGuildId: 'guild-a',
    audienceType: 'member', amount: 30, reason: 'synthetic', actorUserId: 'owner' };
  const preview = await previewOwnerCampaign({ ...base, memberIds: ['user-1', 'user-2'] });
  await reviewCampaignUsers(base.campaignId, ['user-1']);
  const partial = await applyOwnerCampaign({ ...base, previewToken: preview.previewToken,
    presentMemberIds: ['user-1', 'user-2'] });
  assert.equal(partial.granted, 1);
  assert.deepEqual(partial.historyBlocked,
    [{ userId: 'user-2', code: 'CAMPAIGN_HISTORY_UNRECONCILED' }]);
  assert.equal((await getPlayerBalance('guild-a', 'user-1')).balance, 30);
  assert.equal((await getPlayerBalance('guild-a', 'user-2')).balance, 0);
  await reviewCampaignUsers(base.campaignId, ['user-2']);
  const resumed = await applyOwnerCampaign({ ...base, previewToken: preview.previewToken,
    presentMemberIds: ['user-1', 'user-2'] });
  assert.equal(resumed.granted, 1);
  assert.equal(resumed.alreadyGranted, 1);
  assert.equal((await getPlayerBalance('guild-a', 'user-2')).balance, 30);
});

test('manual adjustments use interaction receipts; reviewed historic grants import without issuing coins', async () => {
  const input = { action: 'add', amount: 80, operatorId: 'owner', reason: 'synthetic', operationId: 'interaction-1' };
  const first = await adjustPlayerBalance('guild-a', 'user-1', input);
  const retry = await adjustPlayerBalance('guild-a', 'user-1', input);
  assert.equal(first.alreadyApplied, false);
  assert.equal(retry.alreadyApplied, true);
  assert.equal((await getPlayerBalance('guild-a', 'user-1')).balance, 80);
  await assert.rejects(adjustPlayerBalance('guild-a', 'user-1', { ...input, amount: 81 }),
    { code: 'OPERATION_CONFLICT' });
  const transaction = await withCoinDatabase((api) => api.get(
    "SELECT * FROM coin_transactions WHERE user_id = 'user-1' AND type = 'admin_add'"
  ));
  const transactionId = Number(transaction.id);
  const evidenceHash = crypto.createHash('sha256').update(JSON.stringify(transaction)).digest('hex');
  const history = { campaignId: 'synthetic-old-campaign', actorUserId: 'owner',
    reason: 'reviewed synthetic history', amount: 80,
    recipientRecords: [{ userId: 'user-1', transactionId, evidenceHash }] };
  await assert.rejects(importOwnerCampaignHistory(history), { code: 'HISTORY_EVIDENCE_CONFLICT' });
  await withCoinTransaction((api) => api.run(
    'UPDATE coin_transactions SET metadata = ? WHERE id = ?',
    [JSON.stringify({ ownerCampaignId: history.campaignId }), transactionId]
  ));
  const taggedTransaction = await withCoinDatabase((api) => api.get(
    'SELECT * FROM coin_transactions WHERE id = ?', [transactionId]
  ));
  history.recipientRecords[0].evidenceHash = crypto.createHash('sha256')
    .update(JSON.stringify(taggedTransaction)).digest('hex');
  await assert.rejects(importOwnerCampaignHistory({ ...history, amount: 500 }),
    { code: 'HISTORY_EVIDENCE_CONFLICT' });
  assert.equal((await importOwnerCampaignHistory(history)).imported, 1);
  assert.equal((await importOwnerCampaignHistory(history)).alreadyRecorded, 1);
  const preview = await previewOwnerCampaign({ campaignId: history.campaignId,
    sourceGuildId: 'guild-b', audienceType: 'member', amount: 80,
    reason: 'different display reason', actorUserId: 'owner', memberIds: ['user-1'] });
  assert.equal(preview.alreadyGranted, 1);
  await reviewCampaignUsers(history.campaignId, ['user-1'], ['user-1']);
  const applied = await applyOwnerCampaign({ campaignId: history.campaignId,
    sourceGuildId: 'guild-b', audienceType: 'member', actorUserId: 'owner',
    previewToken: preview.previewToken, presentMemberIds: ['user-1'] });
  assert.equal(applied.granted, 0);
  assert.equal((await getPlayerBalance('guild-b', 'user-1')).balance, 80);
});

test('owner campaign command fails closed when the full member fetch is incomplete', async () => {
  const originalOwnerId = process.env.BOT_OWNER_ID;
  process.env.BOT_OWNER_ID = 'owner';
  let message;
  try {
    const interaction = {
      commandName: 'coin-admin', guildId: 'guild-a',
      guild: { memberCount: 2, members: { fetch: async () => new Map([['owner', { id: 'owner', user: { bot: false } }]]) } },
      user: { id: 'owner', tag: 'owner' }, inGuild: () => true,
      options: {
        getSubcommand: () => 'campaign-preview',
        getString: (name) => ({ 'campaign-id': 'synthetic-incomplete', audience: 'member' })[name],
        getRole: () => null,
      },
      deferred: false, replied: false,
      deferReply: async () => { interaction.deferred = true; },
      editReply: async (text) => { message = text; },
    };
    await coinAdminCommand.execute(interaction);
    assert.match(message, /完整成員名單/);
    assert.equal(fs.existsSync(dbPath), false);
  } finally {
    if (originalOwnerId === undefined) delete process.env.BOT_OWNER_ID;
    else process.env.BOT_OWNER_ID = originalOwnerId;
  }
});

test('campaign service also rejects a non-owner before creating a database', async () => {
  await assert.rejects(previewOwnerCampaign({ campaignId: 'synthetic-denied',
    sourceGuildId: 'guild-a', audienceType: 'member', amount: 20,
    reason: 'synthetic', actorUserId: 'not-owner', memberIds: ['user-1'] }),
  { code: 'OWNER_ONLY' });
  assert.equal(fs.existsSync(dbPath), false);
});

test('old unreviewed grants cannot be paid twice, even with a new campaign ID', async () => {
  await adjustPlayerBalance('guild-a', 'user-1', { action: 'add', amount: 100,
    operatorId: 'owner', reason: 'synthetic old activity' });
  const base = { campaignId: 'synthetic-previous-activity', sourceGuildId: 'guild-a',
    audienceType: 'member', amount: 100, reason: 'same old activity', actorUserId: 'owner' };
  const preview = await previewOwnerCampaign({ ...base, memberIds: ['user-1'] });
  assert.equal(preview.alreadyGranted, 0);
  assert.equal(preview.historyUnreviewed, 1);
  await assert.rejects(applyOwnerCampaign({ ...base, previewToken: preview.previewToken,
    presentMemberIds: ['user-1'] }), { code: 'CAMPAIGN_HISTORY_UNRECONCILED' });
  assert.equal((await getPlayerBalance('guild-a', 'user-1')).balance, 100);
  const plan = await getOwnerCampaignHistoryReviewPlan({ campaignId: base.campaignId,
    userIds: ['user-1'], actorUserId: 'owner' });
  await assert.rejects(reviewOwnerCampaignHistory({ campaignId: base.campaignId,
    actorUserId: 'owner', reviewId: 'a'.repeat(64), sourceSha256: plan.sourceSha256,
    decisions: [{ userId: 'user-1', priorGrant: true,
      reviewedTransactionIds: plan.transactions.map((row) => row.id),
      reviewedLegacyGrantIds: [],
      reviewedAdminLogIds: plan.adminLogs.map((row) => row.id),
      reviewReason: 'synthetic old activity' }] }),
  { code: 'HISTORY_EVIDENCE_CONFLICT' });
});

test('a legacy grant naming the same campaign cannot be classified as another source', async () => {
  const campaignId = 'synthetic-legacy-same';
  await withCoinTransaction((api) => api.run(`INSERT INTO reward_grants
    (guild_id,user_id,source_type,source_id,reward_kind,amount,created_at)
    VALUES ('guild-a','user-1','owner-campaign',?,'campaign',50,'2026-09-26')`,
  [campaignId]));
  await previewOwnerCampaign({ campaignId, sourceGuildId: 'guild-a',
    audienceType: 'member', amount: 50, reason: 'synthetic',
    actorUserId: 'owner', memberIds: ['user-1'] });
  const plan = await getOwnerCampaignHistoryReviewPlan({ campaignId,
    userIds: ['user-1'], actorUserId: 'owner' });
  await assert.rejects(classifyOwnerCampaignHistoryRecord({ campaignId,
    actorUserId: 'owner', userId: 'user-1', sourceSha256: plan.sourceSha256,
    recordType: 'legacy_grant', recordId: plan.legacyGrants[0].id,
    evidenceReference: `owner-campaign:${campaignId}`, reviewReason: 'same source' }),
  { code: 'HISTORY_SOURCE_UNRESOLVED' });
  await assert.rejects(reviewOwnerCampaignHistory({ campaignId,
    actorUserId: 'owner', reviewId: 'c'.repeat(64), sourceSha256: plan.sourceSha256,
    decisions: [{ userId: 'user-1', priorGrant: false,
      reviewedTransactionIds: [], reviewedLegacyGrantIds: [plan.legacyGrants[0].id],
      reviewedAdminLogIds: [], reviewReason: 'synthetic same-source check' }] }),
  { code: 'HISTORY_EVIDENCE_CONFLICT' });
});

test('history review rejects a transaction added after its source inventory was captured', async () => {
  const campaignId = 'synthetic-changed-history';
  await previewOwnerCampaign({ campaignId, sourceGuildId: 'guild-a',
    audienceType: 'member', amount: 25, reason: 'synthetic',
    actorUserId: 'owner', memberIds: ['user-1'] });
  const plan = await getOwnerCampaignHistoryReviewPlan({ campaignId,
    userIds: ['user-1'], actorUserId: 'owner' });
  await adjustPlayerBalance('guild-a', 'user-1', { action: 'add', amount: 25,
    operatorId: 'owner', reason: 'synthetic later transaction' });
  await assert.rejects(reviewOwnerCampaignHistory({ campaignId,
    actorUserId: 'owner', reviewId: 'b'.repeat(64), sourceSha256: plan.sourceSha256,
    decisions: [{ userId: 'user-1', priorGrant: false,
      reviewedTransactionIds: [], reviewedLegacyGrantIds: [], reviewedAdminLogIds: [],
      reviewReason: 'synthetic source inventory' }] }),
  { code: 'HISTORY_SOURCE_CHANGED' });
});

test('apply blocks a newly added untagged admin grant after review', async () => {
  const base = { campaignId: 'synthetic-rechecked-campaign', sourceGuildId: 'guild-a',
    audienceType: 'member', amount: 100, reason: 'synthetic', actorUserId: 'owner' };
  const preview = await previewOwnerCampaign({ ...base, memberIds: ['user-1'] });
  await reviewCampaignUsers(base.campaignId, ['user-1']);
  await adjustPlayerBalance('guild-a', 'user-1', { action: 'add', amount: 100,
    operatorId: 'owner', reason: 'synthetic unrelated income' });
  await assert.rejects(applyOwnerCampaign({ ...base, previewToken: preview.previewToken,
    presentMemberIds: ['user-1'] }), { code: 'CAMPAIGN_HISTORY_CHANGED' });
  assert.equal((await getPlayerBalance('guild-a', 'user-1')).balance, 100);
  const changedPlan = await getOwnerCampaignHistoryReviewPlan({
    campaignId: base.campaignId, userIds: ['user-1'], actorUserId: 'owner' });
  await assert.rejects(classifyOwnerCampaignHistoryRecord({ campaignId: base.campaignId,
      actorUserId: 'owner', userId: 'user-1', sourceSha256: changedPlan.sourceSha256,
      recordType: 'transaction', recordId: changedPlan.unresolvedByUser['user-1'].transactions[0].id,
      evidenceReference: 'synthetic-unrelated-activity', reviewReason: 'no source in row' }),
  { code: 'HISTORY_SOURCE_UNRESOLVED' });
});

test('explicit other-source classification permits re-review and own campaign receipts still resume', async () => {
  const base = { campaignId: 'synthetic-other-source', sourceGuildId: 'guild-a',
    audienceType: 'member', amount: 100, reason: 'synthetic', actorUserId: 'owner' };
  const preview = await previewOwnerCampaign({ ...base, memberIds: ['user-1'] });
  await reviewCampaignUsers(base.campaignId, ['user-1']);
  await withCoinTransaction((api) => mutateWalletWithApi(api, {
    guildId: 'guild-a', userId: 'user-1', type: 'system_reward',
    balanceDelta: 100, totalEarnedDelta: 100,
    metadata: { canonicalSourceId: 'other-verified-activity' },
  }));
  await assert.rejects(applyOwnerCampaign({ ...base, previewToken: preview.previewToken,
    presentMemberIds: ['user-1'] }), { code: 'CAMPAIGN_HISTORY_CHANGED' });
  const changedPlan = await getOwnerCampaignHistoryReviewPlan({
    campaignId: base.campaignId, userIds: ['user-1'], actorUserId: 'owner' });
  await classifyOwnerCampaignHistoryRecord({ campaignId: base.campaignId,
    actorUserId: 'owner', userId: 'user-1', sourceSha256: changedPlan.sourceSha256,
    recordType: 'transaction', recordId: changedPlan.unresolvedByUser['user-1'].transactions[0].id,
    evidenceReference: 'other-verified-activity', reviewReason: 'metadata names another source' });
  await reviewCampaignUsers(base.campaignId, ['user-1']);
  const issued = await applyOwnerCampaign({ ...base, previewToken: preview.previewToken,
    presentMemberIds: ['user-1'] });
  assert.equal(issued.granted, 1);
  assert.equal((await getPlayerBalance('guild-a', 'user-1')).balance, 200);
  const resumed = await applyOwnerCampaign({ ...base, previewToken: preview.previewToken,
    presentMemberIds: ['user-1'] });
  assert.equal(resumed.granted, 0);
  assert.equal(resumed.alreadyGranted, 1);
  assert.equal((await getPlayerBalance('guild-a', 'user-1')).balance, 200);
});

test('campaign role snapshots include bot accounts when the complete guild roster includes them', async () => {
  let message;
  const interaction = {
    commandName: 'coin-admin', guildId: 'guild-a',
    guild: { memberCount: 2, members: { fetch: async () => new Map([
      ['owner', { id: 'owner', user: { bot: false }, roles: { cache: new Map([['role-1', true]]) } }],
      ['bot-1', { id: 'bot-1', user: { bot: true }, roles: { cache: new Map([['role-1', true]]) } }],
    ]) } },
    user: { id: 'owner', tag: 'owner' }, inGuild: () => true,
    options: {
      getSubcommand: () => 'campaign-preview',
      getString: (name) => ({ 'campaign-id': 'synthetic-bot-audience', audience: 'role',
        reason: 'synthetic' })[name],
      getInteger: () => 10, getRole: () => ({ id: 'role-1' }), getUser: () => null,
    },
    deferred: false, replied: false,
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (text) => { message = text; },
  };
  await coinAdminCommand.execute(interaction);
  assert.match(message, /本次名單 2 人/);
  assert.match(message, /歷史對帳待確認：2 人/);
});

test('Discord owner can preview, review an empty history, apply, and resume a new role campaign', async () => {
  const members = new Map([
    ['owner', { id: 'owner', user: { bot: false }, roles: { cache: new Map([['role-1', true]]) } }],
    ['bot-1', { id: 'bot-1', user: { bot: true }, roles: { cache: new Map([['role-1', true]]) } }],
  ]);
  const scope = { 'campaign-id': 'synthetic-discord-new', audience: 'role', role: { id: 'role-1' } };
  const preview = await runCampaignCommand('campaign-preview',
    { ...scope, amount: 25, reason: 'synthetic new campaign' }, members);
  assert.match(preview, /本次名單 2 人/);
  const previewToken = preview.match(/預覽識別碼：([a-f0-9]{64})/)[1];
  const plan = await runCampaignCommand('campaign-history-plan', scope, members);
  assert.match(plan, /可批次核對且無舊發款候選：2 人/);
  const reviewToken = plan.match(/批次核對識別碼：([a-f0-9]{64})/)[1];
  const reviewed = await runCampaignCommand('campaign-history-review', { ...scope,
    'review-token': reviewToken, reason: '已檢視完整虛構來源，確認未發', confirm: '已核對未發' }, members);
  assert.match(reviewed, /已記錄 2 人/);
  const applied = await runCampaignCommand('campaign-apply', { ...scope,
    'preview-token': previewToken, confirm: '發幣' }, members);
  assert.match(applied, /本輪新發 2 人/);
  assert.equal((await getPlayerBalance('guild-a', 'owner')).balance, 25);
  assert.equal((await getPlayerBalance('guild-a', 'bot-1')).balance, 25);
  const resumed = await runCampaignCommand('campaign-apply', { ...scope,
    'preview-token': previewToken, confirm: '發幣' }, members);
  assert.match(resumed, /本輪新發 0 人/);
  assert.equal((await getPlayerBalance('guild-a', 'owner')).balance, 25);
});

test('Discord owner can link a verified prior campaign transaction without paying it again', async () => {
  const campaignId = 'synthetic-discord-prior';
  await getPlayerBalance('guild-a', 'user-1');
  const transactionId = await withCoinTransaction((api) => {
    const mutation = mutateWalletWithApi(api, {
      guildId: 'guild-a', userId: 'user-1', type: 'admin_add',
      balanceDelta: 50, totalEarnedDelta: 50,
      reason: 'synthetic prior campaign', metadata: { ownerCampaignId: campaignId },
    });
    return mutation.transactionId;
  });
  const members = new Map([['user-1', { id: 'user-1', user: { bot: false } }]]);
  const scope = { 'campaign-id': campaignId, audience: 'member', user: 'user-1' };
  const preview = await runCampaignCommand('campaign-preview',
    { ...scope, amount: 50, reason: 'synthetic prior campaign' }, members);
  const previewToken = preview.match(/預覽識別碼：([a-f0-9]{64})/)[1];
  const plan = await runCampaignCommand('campaign-history-plan', scope, members);
  assert.match(plan, new RegExp(`交易 #${transactionId}`));
  const reviewToken = plan.match(/單人核對識別碼：([a-f0-9]{64})/)[1];
  const imported = await runCampaignCommand('campaign-history-import', { ...scope,
    'review-token': reviewToken, 'transaction-id': transactionId,
    reason: '交易 metadata 明確標記同活動', confirm: '已發對應' }, members);
  assert.match(imported, /新增收據 1 筆、對帳 1 人/);
  const applied = await runCampaignCommand('campaign-apply', { ...scope,
    'preview-token': previewToken, confirm: '發幣' }, members);
  assert.match(applied, /本輪新發 0 人/);
  assert.equal((await getPlayerBalance('guild-a', 'user-1')).balance, 50);
});

test('Discord owner can classify a proven other source before reviewing a new campaign', async () => {
  await getPlayerBalance('guild-a', 'user-1');
  const transactionId = await withCoinTransaction((api) => mutateWalletWithApi(api, {
    guildId: 'guild-a', userId: 'user-1', type: 'system_reward',
    balanceDelta: 40, totalEarnedDelta: 40,
    metadata: { canonicalSourceId: 'other-verified-activity' },
  }).transactionId);
  const members = new Map([['user-1', { id: 'user-1', user: { bot: false } }]]);
  const scope = { 'campaign-id': 'synthetic-other-discord', audience: 'member', user: 'user-1' };
  const preview = await runCampaignCommand('campaign-preview',
    { ...scope, amount: 25, reason: 'synthetic new activity' }, members);
  const previewToken = preview.match(/預覽識別碼：([a-f0-9]{64})/)[1];
  const plan = await runCampaignCommand('campaign-history-plan', scope, members);
  assert.match(plan, /other-verified-activity/);
  const reviewToken = plan.match(/單人核對識別碼：([a-f0-9]{64})/)[1];
  const classified = await runCampaignCommand('campaign-history-classify', { ...scope,
    'review-token': reviewToken, 'record-type': 'transaction', 'record-id': transactionId,
    'evidence-mode': 'record',
    'source-reference': 'other-verified-activity', reason: '交易欄位明確指向另一活動',
    confirm: '不屬於本活動' }, members);
  assert.match(classified, new RegExp(`transaction #${transactionId}`));
  const reviewed = await runCampaignCommand('campaign-history-review', { ...scope,
    'review-token': reviewToken, reason: '已核對交易來源為另一活動',
    confirm: '已核對未發' }, members);
  assert.match(reviewed, /已記錄 1 人/);
  const applied = await runCampaignCommand('campaign-apply', { ...scope,
    'preview-token': previewToken, confirm: '發幣' }, members);
  assert.match(applied, /本輪新發 1 人/);
  assert.equal((await getPlayerBalance('guild-a', 'user-1')).balance, 65);
});

test('OWNER can attest an old admin add with linked audit and outside evidence, then issue a different campaign', async () => {
  await adjustPlayerBalance('guild-a', 'user-1', { action: 'add', amount: 40,
    operatorId: 'owner', reason: 'synthetic earlier activity' });
  const members = new Map([['user-1', { id: 'user-1', user: { bot: false } }]]);
  const scope = { 'campaign-id': 'synthetic-new-after-old', audience: 'member', user: 'user-1' };
  const preview = await runCampaignCommand('campaign-preview',
    { ...scope, amount: 25, reason: 'synthetic new activity' }, members);
  const previewToken = preview.match(/預覽識別碼：([a-f0-9]{64})/)[1];
  const planText = await runCampaignCommand('campaign-history-plan', scope, members);
  const reviewToken = planText.match(/單人核對識別碼：([a-f0-9]{64})/)[1];
  const plan = await getOwnerCampaignHistoryReviewPlan({ campaignId: scope['campaign-id'],
    userIds: ['user-1'], actorUserId: 'owner' });
  const transactionId = plan.unresolvedByUser['user-1'].transactions[0].id;
  assert.match(planText, new RegExp(`交易 #${transactionId}`));
  const classified = await runCampaignCommand('campaign-history-classify', { ...scope,
    'review-token': reviewToken, 'record-type': 'transaction', 'record-id': transactionId,
    'evidence-mode': 'owner_evidence', 'source-reference': 'external-case-earlier-activity',
    reason: '已核對舊活動憑證及管理紀錄，確認與新活動無關', confirm: '已核外證非本活動' }, members);
  assert.match(classified, /OWNER 人工外證判定（連結管理紀錄 #\d+）/);
  const saved = await withCoinDatabase((api) => api.get(`SELECT * FROM coin_owner_campaign_history_classifications
    WHERE campaign_id = ? AND user_id = ? AND record_type = 'transaction' AND record_id = ?`,
  [scope['campaign-id'], 'user-1', transactionId]));
  assert.deepEqual(JSON.parse(saved.evidence_reference), {
    mode: 'owner_evidence', reference: 'external-case-earlier-activity',
    linkedAdminLogId: Number(classified.match(/連結管理紀錄 #(\d+)/)[1]),
  });
  assert.equal(saved.reviewed_by, 'owner');
  const reviewed = await runCampaignCommand('campaign-history-review', { ...scope,
    'review-token': reviewToken, reason: '已核對舊活動來源與本次名單', confirm: '已核對未發' }, members);
  assert.match(reviewed, /已記錄 1 人/);
  const applied = await runCampaignCommand('campaign-apply', { ...scope,
    'preview-token': previewToken, confirm: '發幣' }, members);
  assert.match(applied, /本輪新發 1 人/);
  assert.equal((await getPlayerBalance('guild-a', 'user-1')).balance, 65);
});

test('manual other-source attestation must be repeated after source history changes', async () => {
  await adjustPlayerBalance('guild-a', 'user-1', { action: 'add', amount: 25,
    operatorId: 'owner', reason: 'synthetic earlier campaign' });
  const otherId = 'synthetic-source-bound';
  await previewOwnerCampaign({ campaignId: otherId, sourceGuildId: 'guild-a', audienceType: 'member',
    amount: 25, reason: 'another new campaign', actorUserId: 'owner', memberIds: ['user-1'] });
  const otherPlan = await getOwnerCampaignHistoryReviewPlan({ campaignId: otherId,
    userIds: ['user-1'], actorUserId: 'owner' });
  const recordId = otherPlan.unresolvedByUser['user-1'].transactions[0].id;
  await classifyOwnerCampaignHistoryRecord({ campaignId: otherId, actorUserId: 'owner',
    userId: 'user-1', sourceSha256: otherPlan.sourceSha256, recordType: 'transaction', recordId,
    evidenceMode: 'owner_evidence', evidenceReference: 'external-case-earlier',
    reviewReason: 'synthetic earlier campaign independently verified' });
  await adjustPlayerBalance('guild-a', 'user-1', { action: 'set', amount: 25,
    operatorId: 'owner', reason: 'synthetic source drift' });
  const changedPlan = await getOwnerCampaignHistoryReviewPlan({ campaignId: otherId,
    userIds: ['user-1'], actorUserId: 'owner' });
  await assert.rejects(reviewOwnerCampaignHistory({ campaignId: otherId, actorUserId: 'owner',
    reviewId: 'd'.repeat(64), sourceSha256: changedPlan.sourceSha256,
    decisions: [{ userId: 'user-1', priorGrant: false,
      reviewedTransactionIds: changedPlan.transactions.map((row) => row.id),
      reviewedLegacyGrantIds: changedPlan.legacyGrants.map((row) => row.id),
      reviewedAdminLogIds: changedPlan.adminLogs.map((row) => row.id),
      reviewReason: 'synthetic source drift' }] }), { code: 'HISTORY_SOURCE_UNRESOLVED' });
});

test('manual evidence cannot override a transaction tagged to this campaign or an unlinked reward', async () => {
  const campaignId = 'synthetic-tagged-same';
  await getPlayerBalance('guild-a', 'user-1');
  const ids = await withCoinTransaction((api) => ({
    tagged: mutateWalletWithApi(api, { guildId: 'guild-a', userId: 'user-1',
      type: 'admin_add', balanceDelta: 25, totalEarnedDelta: 25,
      reason: 'synthetic old grant', metadata: { canonicalSourceId: campaignId } }).transactionId,
    unlinked: mutateWalletWithApi(api, { guildId: 'guild-a', userId: 'user-1',
      type: 'system_reward', balanceDelta: 10, totalEarnedDelta: 10,
      reason: 'synthetic unlinked reward' }).transactionId,
  }));
  await previewOwnerCampaign({ campaignId, sourceGuildId: 'guild-a', audienceType: 'member',
    amount: 25, reason: 'synthetic new campaign', actorUserId: 'owner', memberIds: ['user-1'] });
  const plan = await getOwnerCampaignHistoryReviewPlan({ campaignId, userIds: ['user-1'], actorUserId: 'owner' });
  for (const recordId of [ids.tagged, ids.unlinked]) {
    await assert.rejects(classifyOwnerCampaignHistoryRecord({ campaignId, actorUserId: 'owner',
      userId: 'user-1', sourceSha256: plan.sourceSha256, recordType: 'transaction', recordId,
      evidenceMode: 'owner_evidence', evidenceReference: 'external-case-cannot-override',
      reviewReason: 'synthetic manual override must be rejected' }),
    { code: 'HISTORY_SOURCE_UNRESOLVED' });
  }
});

async function makeSyntheticV21Fixture() {
  await initializeCoinDatabase();
  await getPlayerBalance('guild-a', 'user-1');
  await getPlayerBalance('guild-b', 'user-1');
  const now = new Date();
  const taipeiDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei',
    hour: '2-digit', hourCycle: 'h23' }).format(now));
  const settlementDate = hour >= 23 ? taipeiDate :
    new Date(Date.parse(`${taipeiDate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  await withCoinTransaction((api) => {
    api.run('UPDATE coin_guild_players SET bank_balance = 1000, bank_interest_accrued = 0.25, last_interest_date = ? WHERE guild_id = ? AND user_id = ?',
      [settlementDate, 'guild-a', 'user-1']);
    api.run('UPDATE coin_guild_players SET bank_balance = 2000, bank_interest_accrued = 0.5, last_interest_date = ? WHERE guild_id = ? AND user_id = ?',
      [settlementDate, 'guild-b', 'user-1']);
    api.run(`INSERT INTO chip_accounts (guild_id,user_id,balance,created_at,updated_at)
      VALUES ('guild-a','user-1',100,'2026-09-26','2026-09-26'),
             ('guild-b','user-1',200,'2026-09-26','2026-09-26')`);
    api.run(`INSERT INTO coin_fixed_deposits
      (guild_id,user_id,principal,term_days,rate,expected_interest,source,status,created_at,maturity_at)
      VALUES ('guild-a','user-1',1000,7,0.0035,3,'wallet','active','2026-09-26','2026-10-03')`);
    api.run(`INSERT INTO casino_loans
      (guild_id,user_id,principal_amount,current_debt_amount,interest_rate,status,created_at,updated_at,last_interest_date)
      VALUES ('guild-b','user-1',500,500,0.03,'active','2026-09-26','2026-09-26',?)`, [settlementDate]);
    api.run(`INSERT INTO casino_venue_orders
      (guild_id,customer_id,status,created_at,updated_at)
      VALUES ('guild-a','user-1','served','2026-09-26','2026-09-26')`);
  });
  resetCoinDatabaseForTests();
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const db = new SQL.Database(fs.readFileSync(dbPath));
  db.exec('PRAGMA foreign_keys = OFF');
  for (const table of [
    'coin_owner_campaign_history_classifications', 'coin_owner_campaign_history_reviews',
    'coin_owner_campaign_audience_members',
    'coin_owner_campaign_recipients', 'coin_owner_campaign_audiences', 'coin_owner_campaigns',
    'discord_game_actions', 'discord_game_rewards', 'discord_game_sessions',
    'coin_work_legacy_snapshot_items', 'coin_work_legacy_snapshots',
    'coin_work_legacy_settlements', 'coin_primary_cycle_payroll',
    'coin_primary_cycle_penalty_appeals', 'coin_primary_cycle_penalties',
    'coin_primary_job_cycles', 'coin_primary_jobs_global',
    'coin_operation_receipts', 'reward_grants_v2', 'coin_bank_accounts_global',
    'coin_bank_rates_global', 'coin_rate_history_global', 'chip_accounts_global',
    'coin_global_economy_migrations',
  ]) db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.exec('DROP INDEX IF EXISTS idx_venue_orders_waiter_global_cycle');
  db.exec('ALTER TABLE casino_venue_orders DROP COLUMN waiter_global_cycle_id');
  db.exec("UPDATE coin_metadata SET value = '21' WHERE key = 'schema_version'");
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

async function changeSyntheticV21Fixture(sql) {
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const db = new SQL.Database(fs.readFileSync(dbPath));
  db.exec(sql);
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

test('v21 synthetic multi-guild assets migrate with a versioned conservation receipt and survive reopen', async () => {
  await makeSyntheticV21Fixture();
  const plan = await dryRunGlobalEconomyV22();
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.totals.bankBalance, 3000);
  assert.equal(plan.totals.chipBalance, 300);
  assert.equal(plan.totals.fixedPrincipal, 1000);
  assert.equal(plan.totals.fixedInterest, 3);
  assert.equal(plan.totals.loanPrincipal, 500);
  assert.equal(plan.totals.loanDebt, 500);
  assert.equal(plan.totals.interestAccrued, 0.75);
  process.env.COIN_V22_EXPECTED_SOURCE_SHA256 = plan.sourceSha256;
  assert.equal((await initializeCoinDatabase()).schemaVersion, 22);
  assert.equal((await getBalanceSummary('guild-b', 'user-1')).bankBalance, 3000);
  assert.equal((await getChipBalance('guild-a', 'user-1')).balance, 300);
  const receipt = await withCoinDatabase((api) => api.get(
    'SELECT * FROM coin_global_economy_migrations WHERE to_version = 22'));
  assert.equal(receipt.source_sha256, plan.sourceSha256);
  assert.equal(receipt.target_bank_balance_sum, 3000);
  assert.equal(receipt.target_fixed_interest_sum, 3);
  assert.equal(receipt.target_loan_principal_sum, 500);
  const waiterColumn = await withCoinDatabase((api) => ({
    column: api.all('PRAGMA table_info(casino_venue_orders)')
      .find((row) => row.name === 'waiter_global_cycle_id'),
    foreignKey: api.all('PRAGMA foreign_key_list(casino_venue_orders)')
      .find((row) => row.from === 'waiter_global_cycle_id'),
    index: api.all('PRAGMA index_info(idx_venue_orders_waiter_global_cycle)').map((row) => row.name),
    oldOrder: api.get('SELECT waiter_global_cycle_id FROM casino_venue_orders LIMIT 1'),
  }));
  assert.ok(waiterColumn.column);
  assert.equal(waiterColumn.foreignKey.table, 'coin_primary_job_cycles');
  assert.deepEqual(waiterColumn.index, ['waiter_global_cycle_id', 'tip_status', 'id']);
  assert.equal(waiterColumn.oldOrder.waiter_global_cycle_id, null);
  resetCoinDatabaseForTests();
  assert.equal((await getCoinDatabaseInfo()).schemaVersion, 22);
  assert.equal((await getBalanceSummary('guild-a', 'user-1')).bankBalance, 3000);
});

test('unsettled legacy rate event stops migration without changing source bytes', async () => {
  await makeSyntheticV21Fixture();
  const distPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (fileName) => path.join(distPath, fileName) });
  const db = new SQL.Database(fs.readFileSync(dbPath));
  db.run(`INSERT INTO coin_bank_rates
    (guild_id,rate_key,rate,previous_rate,is_event,event_ends_at,updated_at)
    VALUES ('guild-a','demand',0.01,0.0003,1,'2099-01-01','2026-09-26')`);
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
  const before = fs.readFileSync(dbPath);
  const plan = await dryRunGlobalEconomyV22();
  assert.ok(plan.conflicts.some((conflict) => conflict.code === 'LEGACY_RATE_EVENT'));
  process.env.COIN_V22_EXPECTED_SOURCE_SHA256 = plan.sourceSha256;
  await assert.rejects(initializeCoinDatabase(), /v22/);
  assert.deepEqual(fs.readFileSync(dbPath), before);
});

test('existing v21 source requires the exact reviewed hash before apply', async () => {
  await makeSyntheticV21Fixture();
  const before = fs.readFileSync(dbPath);
  await assert.rejects(initializeCoinDatabase(), /v22/);
  assert.deepEqual(fs.readFileSync(dbPath), before);
  process.env.COIN_V22_EXPECTED_SOURCE_SHA256 = '0'.repeat(64);
  await assert.rejects(initializeCoinDatabase(), /v22/);
  assert.deepEqual(fs.readFileSync(dbPath), before);
});

test('reviewed v21 source hash covers wallet and debt changes', async () => {
  await makeSyntheticV21Fixture();
  const plan = await dryRunGlobalEconomyV22();
  await changeSyntheticV21Fixture(`UPDATE coin_wallets SET balance = balance + 1 WHERE user_id = 'user-1';
    INSERT INTO coin_debts (user_id, amount, created_at, updated_at)
    VALUES ('user-1', 7, '2026-09-26', '2026-09-26')`);
  const changed = fs.readFileSync(dbPath);
  const secondPlan = await dryRunGlobalEconomyV22();
  assert.notEqual(secondPlan.sourceSha256, plan.sourceSha256);
  process.env.COIN_V22_EXPECTED_SOURCE_SHA256 = plan.sourceSha256;
  await assert.rejects(initializeCoinDatabase(), /v22/);
  assert.deepEqual(fs.readFileSync(dbPath), changed);
});

test('multiple legacy active loans require a decision and leave v21 bytes untouched', async () => {
  await makeSyntheticV21Fixture();
  await changeSyntheticV21Fixture(`INSERT INTO casino_loans
    (guild_id,user_id,principal_amount,current_debt_amount,interest_rate,status,created_at,updated_at,last_interest_date)
    VALUES ('guild-a','user-1',30,30,0.03,'active','2026-09-26','2026-09-26',
      (SELECT last_interest_date FROM casino_loans LIMIT 1))`);
  const before = fs.readFileSync(dbPath);
  const plan = await dryRunGlobalEconomyV22();
  assert.equal(plan.canApply, false);
  assert.ok(plan.decisionRequired.some((item) => item.code === 'MULTIPLE_ACTIVE_LOANS'));
  process.env.COIN_V22_EXPECTED_SOURCE_SHA256 = plan.sourceSha256;
  await assert.rejects(initializeCoinDatabase(), /v22/);
  assert.deepEqual(fs.readFileSync(dbPath), before);
});

test('legacy reward source collision requires a decision and leaves v21 bytes untouched', async () => {
  await makeSyntheticV21Fixture();
  await changeSyntheticV21Fixture(`INSERT INTO reward_grants
    (guild_id,user_id,source_type,source_id,reward_kind,amount,created_at)
    VALUES ('guild-a','user-1','feature','shared-local-id','completion',10,'2026-09-26'),
           ('guild-b','user-1','feature','shared-local-id','completion',20,'2026-09-26')`);
  const before = fs.readFileSync(dbPath);
  const plan = await dryRunGlobalEconomyV22();
  assert.equal(plan.canApply, false);
  assert.ok(plan.decisionRequired.some((item) => item.code === 'LEGACY_REWARD_SOURCE_COLLISION'));
  process.env.COIN_V22_EXPECTED_SOURCE_SHA256 = plan.sourceSha256;
  await assert.rejects(initializeCoinDatabase(), /v22/);
  assert.deepEqual(fs.readFileSync(dbPath), before);
});
