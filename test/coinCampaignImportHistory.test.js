const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Characterization tests for the owner-campaign history import and for every place the
// campaign flow reads the reward ledger. They pin today's behaviour
// so the reward-ledger SQL can move to the ledger's owner without any visible change.
// Only a synthetic coin database in a temporary directory is used.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-campaign-import-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.BOT_OWNER_ID = 'owner-user';

const coinAdmin = require('../src/commands/coin-admin');
const {
  applyOwnerCampaign,
  getOwnerCampaignHistoryReviewPlan,
  getOwnerCampaignPreview,
  importOwnerCampaignHistory,
  previewOwnerCampaign,
  reviewOwnerCampaignHistory,
} = require('../src/services/coinCampaignService');
const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const { setGuildEconomyEnabled } = require('../src/services/coinService');
const { getWalletPlayerWithApi, mutateWalletWithApi, setDebtWithApi } = require('../src/services/coinWalletService');
const { grantRewardOnce } = require('../src/services/featurePlatformService');

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

const OWNER = 'owner-user';
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
// Expected ledger values are derived here, independently of the code under test.
const receiptKeyOf = (campaignId, userId) =>
  `reward:v1:${sha256(JSON.stringify(['owner-campaign', campaignId, 'campaign', userId]))}`;
const payloadHashOf = (campaignId, userId, amount) =>
  sha256(JSON.stringify(['owner-campaign', campaignId, 'campaign', userId, amount]));
const evidenceOf = (transaction) => sha256(JSON.stringify(transaction));
// Timestamps handed out by withSteppingClock.
const STEPPED = /^2026-10-02T03:\d{2}:\d{2}\.000Z$/u;

// Inside `work`, every argument-less `new Date()` reads one second later than the previous
// one, so two stored timestamps are equal only when the code took them from one reading.
async function withSteppingClock(work) {
  const RealDate = globalThis.Date;
  const start = RealDate.parse('2026-10-02T03:00:00.000Z');
  let tick = 0;
  class SteppingDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        tick += 1;
        super(start + tick * 1000);
      } else {
        super(...args);
      }
    }

    static [Symbol.hasInstance](value) {
      return value instanceof RealDate;
    }
  }
  globalThis.Date = SteppingDate;
  try {
    return await work();
  } finally {
    globalThis.Date = RealDate;
  }
}

// Records one historical payment the way the wallet stores it and returns the stored row.
function seedPayment({ guildId, userId, amount, type = 'admin_add', debt = 0, metadata }) {
  return withCoinTransaction((api) => {
    getWalletPlayerWithApi(api, guildId, userId);
    if (debt > 0) setDebtWithApi(api, userId, debt);
    const { transactionId } = mutateWalletWithApi(api, {
      guildId, userId, type, balanceDelta: amount, totalEarnedDelta: Math.max(amount, 0),
      operatorId: OWNER, reason: 'synthetic historical payment', metadata, debtOffset: true,
    });
    return api.get('SELECT * FROM coin_transactions WHERE id = ?', [transactionId]);
  });
}

// Edits one stored payment, as drifted or hand-edited history would look, and returns the row.
function rewritePayment(id, column, value) {
  return withCoinTransaction((api) => {
    api.run(`UPDATE coin_transactions SET ${column} = ? WHERE id = ?`, [value, id]);
    return api.get('SELECT * FROM coin_transactions WHERE id = ?', [id]);
  });
}

const receiptOf = (campaignId, userId) => withCoinDatabase((api) =>
  api.get('SELECT * FROM reward_grants_v2 WHERE reward_key = ?', [receiptKeyOf(campaignId, userId)]));
const campaignOf = (campaignId) => withCoinDatabase((api) =>
  api.get('SELECT * FROM coin_owner_campaigns WHERE campaign_id = ?', [campaignId]));
// Every table an import could touch, to prove that a refused or repeated import changes nothing.
const ledgerState = () => withCoinDatabase((api) => ({
  receipts: api.all('SELECT * FROM reward_grants_v2 ORDER BY id'),
  legacyGrants: api.all('SELECT * FROM reward_grants ORDER BY id'),
  campaigns: api.all('SELECT * FROM coin_owner_campaigns ORDER BY campaign_id'),
  reviews: api.all('SELECT * FROM coin_owner_campaign_history_reviews ORDER BY campaign_id, user_id'),
  transactions: api.all('SELECT * FROM coin_transactions ORDER BY id'),
  wallets: api.all('SELECT * FROM coin_wallets ORDER BY user_id'),
  debts: api.all('SELECT * FROM coin_debts ORDER BY user_id'),
}));

test('import records a receipt for the reviewed payment, field by field, without paying again', async () => {
  const campaignId = 'import-campaign-debt';
  const userId = 'import-user-debt';
  const payment = await seedPayment({
    guildId: 'guild-import', userId, amount: 100, debt: 30, metadata: { ownerCampaignId: campaignId },
  });
  // The wallet split the historical payment: 30 repaid the debt and 70 reached the wallet.
  assert.equal(payment.amount, 70);
  assert.deepEqual(JSON.parse(payment.metadata).debtOffset,
    { gross: 100, offset: 30, net: 70, debtBefore: 30, debtAfter: 0 });
  const before = await ledgerState();

  const result = await withSteppingClock(() => importOwnerCampaignHistory({
    campaignId, actorUserId: OWNER, amount: 100, reason: '  synthetic import reason  ',
    recipientRecords: [{
      userId, transactionId: String(payment.id), evidenceHash: evidenceOf(payment).toUpperCase(),
    }],
  }));

  assert.deepEqual(result, { campaignId, imported: 1, alreadyRecorded: 0 });
  const campaign = await campaignOf(campaignId);
  assert.match(campaign.created_at, STEPPED);
  assert.deepEqual(campaign, {
    campaign_id: campaignId,
    amount: 100,
    reason: 'synthetic import reason',
    created_by: OWNER,
    created_at: campaign.created_at,
    updated_at: campaign.created_at,
  });
  const receipt = await receiptOf(campaignId, userId);
  assert.equal(Number.isSafeInteger(receipt.id), true);
  assert.deepEqual(receipt, {
    id: receipt.id,
    reward_key: receiptKeyOf(campaignId, userId),
    operation_id: receiptKeyOf(campaignId, userId),
    kind: 'owner-campaign',
    canonical_source_id: campaignId,
    reward_kind: 'campaign',
    user_id: userId,
    source_guild_id: 'guild-import',
    amount: 100,
    payload_hash: payloadHashOf(campaignId, userId, 100),
    metadata_json: JSON.stringify({ imported: true, evidenceHash: evidenceOf(payment) }),
    debt_offset: 30,
    net_amount: 70,
    transaction_id: payment.id,
    legacy_grant_id: null,
    // The receipt and the new campaign row share the import transaction's single clock reading.
    created_at: campaign.created_at,
  });

  // Importing only records the receipt: no wallet, debt, transaction or review row changes.
  const after = await ledgerState();
  assert.deepEqual(after.receipts, [...before.receipts, receipt]);
  assert.deepEqual(after.campaigns.filter((row) => row.campaign_id !== campaignId), before.campaigns);
  for (const table of ['legacyGrants', 'reviews', 'transactions', 'wallets', 'debts']) {
    assert.deepEqual(after[table], before[table], table);
  }
});

test('payments without a debt offset import at full value and an existing campaign row is kept', async () => {
  const campaignId = 'import-campaign-plain';
  const [first, second] = ['import-plain-b', 'import-plain-a'];
  const metadata = { ownerCampaignId: campaignId };
  await previewOwnerCampaign({
    campaignId, sourceGuildId: 'guild-plain', audienceType: 'member', actorUserId: OWNER,
    amount: 80, reason: 'synthetic preview first', memberIds: [first, second],
  });
  const campaignBefore = await campaignOf(campaignId);
  const systemPayment = await seedPayment({ guildId: 'guild-plain', userId: first, amount: 80, type: 'system_reward', metadata });
  const eventPayment = await seedPayment({ guildId: 'guild-plain', userId: second, amount: 80, type: 'event_reward', metadata });

  const result = await withSteppingClock(() => importOwnerCampaignHistory({
    campaignId, actorUserId: OWNER, amount: 80, reason: 'a later reason does not replace the campaign reason',
    recipientRecords: [
      { userId: first, transactionId: systemPayment.id, evidenceHash: evidenceOf(systemPayment) },
      { userId: second, transactionId: eventPayment.id, evidenceHash: evidenceOf(eventPayment) },
    ],
  }));

  assert.deepEqual(result, { campaignId, imported: 2, alreadyRecorded: 0 });
  assert.deepEqual(await campaignOf(campaignId), campaignBefore);
  const firstReceipt = await receiptOf(campaignId, first);
  const secondReceipt = await receiptOf(campaignId, second);
  // Receipts follow the order of the reviewed records and share the import transaction's time.
  assert.equal(secondReceipt.id, firstReceipt.id + 1);
  assert.match(firstReceipt.created_at, STEPPED);
  assert.equal(secondReceipt.created_at, firstReceipt.created_at);
  assert.deepEqual([firstReceipt, secondReceipt].map((row) => [
    row.user_id, row.source_guild_id, row.amount, row.debt_offset, row.net_amount, row.transaction_id,
    row.payload_hash, row.metadata_json,
  ]), [
    [first, 'guild-plain', 80, 0, 80, systemPayment.id, payloadHashOf(campaignId, first, 80),
      JSON.stringify({ imported: true, evidenceHash: evidenceOf(systemPayment) })],
    [second, 'guild-plain', 80, 0, 80, eventPayment.id, payloadHashOf(campaignId, second, 80),
      JSON.stringify({ imported: true, evidenceHash: evidenceOf(eventPayment) })],
  ]);
});

test('re-importing the same evidence records nothing and changes nothing', async () => {
  const campaignId = 'import-campaign-repeat';
  const userId = 'import-user-repeat';
  const payment = await seedPayment({ guildId: 'guild-repeat', userId, amount: 60, metadata: { ownerCampaignId: campaignId } });
  const input = {
    campaignId, actorUserId: OWNER, amount: 60, reason: 'synthetic repeat',
    recipientRecords: [{ userId, transactionId: payment.id, evidenceHash: evidenceOf(payment) }],
  };
  assert.deepEqual(await importOwnerCampaignHistory(input), { campaignId, imported: 1, alreadyRecorded: 0 });
  const before = await ledgerState();

  assert.deepEqual(await importOwnerCampaignHistory(input), { campaignId, imported: 0, alreadyRecorded: 1 });
  assert.deepEqual(await ledgerState(), before);
});

test('a stored receipt that differs from the reviewed evidence is a HISTORY_EVIDENCE_CONFLICT', async () => {
  const campaignId = 'import-campaign-differs';
  const userId = 'import-user-differs';
  const metadata = { ownerCampaignId: campaignId };
  const recorded = await seedPayment({ guildId: 'guild-differs', userId, amount: 45, metadata });
  const another = await seedPayment({ guildId: 'guild-differs', userId, amount: 45, metadata });
  const attempt = (payment) => importOwnerCampaignHistory({
    campaignId, actorUserId: OWNER, amount: 45, reason: 'synthetic differs',
    recipientRecords: [{ userId, transactionId: payment.id, evidenceHash: evidenceOf(payment) }],
  });
  const differs = (error) => error.name === 'CoinCampaignError' && error.code === 'HISTORY_EVIDENCE_CONFLICT' &&
    error.message === 'Existing receipt differs from reviewed evidence.';
  await attempt(recorded);

  // Another payment cannot replace the payment the receipt already names.
  let before = await ledgerState();
  await assert.rejects(attempt(another), differs);
  assert.deepEqual(await ledgerState(), before);

  // A stored receipt for the same payment with another payload is refused as well.
  await withCoinTransaction((api) => api.run('UPDATE reward_grants_v2 SET payload_hash = ? WHERE reward_key = ?',
    ['f'.repeat(64), receiptKeyOf(campaignId, userId)]));
  before = await ledgerState();
  await assert.rejects(attempt(recorded), differs);
  assert.deepEqual(await ledgerState(), before);
});

test('evidence that is not a positive global reward payment to the recipient is refused', async () => {
  const campaignId = 'import-campaign-mismatch';
  const userId = 'import-user-mismatch';
  const guildId = 'guild-mismatch';
  const metadata = { ownerCampaignId: campaignId };
  const valid = await seedPayment({ guildId, userId, amount: 50, metadata });
  const otherUser = await seedPayment({ guildId, userId: 'import-user-other', amount: 50, metadata });
  const adjustment = await seedPayment({ guildId, userId, amount: 50, type: 'wallet_adjustment', metadata });
  const negative = await seedPayment({ guildId, userId, amount: -5, metadata });
  const legacyScope = await rewritePayment(
    (await seedPayment({ guildId, userId, amount: 50, metadata })).id, 'wallet_scope', 'guild_legacy');
  const attempt = (transactionId, evidenceHash) => importOwnerCampaignHistory({
    campaignId, actorUserId: OWNER, amount: 50, reason: 'synthetic mismatch',
    recipientRecords: [{ userId, transactionId, evidenceHash }],
  });
  const mismatch = (error) => error.code === 'HISTORY_EVIDENCE_CONFLICT' &&
    error.message === 'Transaction evidence does not match the recipient.';
  const before = await ledgerState();

  await assert.rejects(attempt(valid.id + 100000, evidenceOf(valid)), mismatch, 'missing payment');
  await assert.rejects(attempt(otherUser.id, evidenceOf(otherUser)), mismatch, 'other member');
  await assert.rejects(attempt(adjustment.id, evidenceOf(adjustment)), mismatch, 'not a reward type');
  await assert.rejects(attempt(negative.id, evidenceOf(negative)), mismatch, 'negative amount');
  await assert.rejects(attempt(legacyScope.id, evidenceOf(legacyScope)), mismatch, 'legacy wallet scope');
  // Nothing is written, not even the campaign row the import would have created.
  assert.deepEqual(await ledgerState(), before);
  assert.equal(await campaignOf(campaignId), null);
});

test('evidence whose hash no longer matches the stored payment is refused', async () => {
  const campaignId = 'import-campaign-hash';
  const userId = 'import-user-hash';
  const payment = await seedPayment({ guildId: 'guild-hash', userId, amount: 35, metadata: { ownerCampaignId: campaignId } });
  const reviewedHash = evidenceOf(payment);
  await rewritePayment(payment.id, 'reason', 'edited after the review');
  const attempt = (evidenceHash) => importOwnerCampaignHistory({
    campaignId, actorUserId: OWNER, amount: 35, reason: 'synthetic hash',
    recipientRecords: [{ userId, transactionId: payment.id, evidenceHash }],
  });
  const changed = (error) => error.code === 'HISTORY_EVIDENCE_CONFLICT' &&
    error.message === 'Transaction evidence hash has changed.';
  const before = await ledgerState();

  await assert.rejects(attempt(reviewedHash), changed);
  await assert.rejects(attempt('0'.repeat(64)), changed);
  assert.deepEqual(await ledgerState(), before);
  assert.equal(await campaignOf(campaignId), null);
});

test('a payment that does not prove this campaign and its gross, offset and net amounts is refused', async () => {
  const campaignId = 'import-campaign-proof';
  const userId = 'import-user-proof';
  const guildId = 'guild-proof';
  const metadata = { ownerCampaignId: campaignId };
  const unproven = [
    await seedPayment({ guildId, userId, amount: 100, metadata: { ownerCampaignId: 'another-campaign' } }),
    await seedPayment({ guildId, userId, amount: 100, metadata: { note: 'names no campaign' } }),
    await rewritePayment((await seedPayment({ guildId, userId, amount: 100, metadata })).id, 'metadata', '{not json'),
    await seedPayment({ guildId, userId, amount: 90, metadata }),
  ];
  for (const debtOffset of [
    { gross: 100, offset: 30, net: 60 }, // net differs from the stored amount (70)
    { gross: 100, offset: 20, net: 70 }, // offset + net differs from gross
    { gross: 100, offset: 30.5, net: 70 }, // offset is not a whole number
    { gross: 100, net: 70 }, // offset is missing
  ]) {
    const payment = await seedPayment({ guildId, userId, amount: 100, debt: 30, metadata });
    unproven.push(await rewritePayment(payment.id, 'metadata', JSON.stringify({ ownerCampaignId: campaignId, debtOffset })));
  }
  const refused = (error) => error.code === 'HISTORY_EVIDENCE_CONFLICT' &&
    error.message === 'Transaction does not prove this campaign and its gross, debt-offset, and net amounts.';
  const before = await ledgerState();

  for (const payment of unproven) {
    await assert.rejects(importOwnerCampaignHistory({
      campaignId, actorUserId: OWNER, amount: 100, reason: 'synthetic proof',
      recipientRecords: [{ userId, transactionId: payment.id, evidenceHash: evidenceOf(payment) }],
    }), refused, `payment #${payment.id}: ${payment.metadata}`);
  }
  assert.deepEqual(await ledgerState(), before);
  assert.equal(await campaignOf(campaignId), null);
});

test('an import for a campaign recorded with another amount is a CAMPAIGN_CONFLICT', async () => {
  const campaignId = 'import-campaign-amount';
  const userId = 'import-user-amount';
  await previewOwnerCampaign({
    campaignId, sourceGuildId: 'guild-amount', audienceType: 'member', actorUserId: OWNER,
    amount: 25, reason: 'synthetic amount preview', memberIds: [userId],
  });
  const payment = await seedPayment({ guildId: 'guild-amount', userId, amount: 30, metadata: { ownerCampaignId: campaignId } });
  const before = await ledgerState();

  await assert.rejects(importOwnerCampaignHistory({
    campaignId, actorUserId: OWNER, amount: 30, reason: 'synthetic amount',
    recipientRecords: [{ userId, transactionId: payment.id, evidenceHash: evidenceOf(payment) }],
  }), (error) => error.code === 'CAMPAIGN_CONFLICT' && error.message === 'Campaign amount differs from the recorded campaign.');
  assert.deepEqual(await ledgerState(), before);
});

test('invalid import requests are refused in a fixed order before the ledger is touched', async () => {
  const hash = 'a'.repeat(64);
  const record = (overrides = {}) => ({ userId: 'import-user-input', transactionId: 1, evidenceHash: hash, ...overrides });
  const valid = {
    campaignId: 'import-campaign-input', actorUserId: OWNER, amount: 10, reason: 'synthetic input',
    recipientRecords: [record()],
  };
  const notVerifiable = 'Each recipient needs unique, verifiable transaction evidence.';
  const cases = [
    [{ campaignId: ' ' }, 'INVALID_ARGUMENT', 'campaignId is required.'],
    [{ campaignId: 'c'.repeat(161) }, 'INVALID_ARGUMENT', 'campaignId is required.'],
    [{ actorUserId: 'someone-else' }, 'OWNER_ONLY', '只有小吉擁有者可以管理活動發幣。'],
    [{ amount: 0 }, 'INVALID_AMOUNT', 'Campaign amount is invalid.'],
    [{ amount: 10.5 }, 'INVALID_AMOUNT', 'Campaign amount is invalid.'],
    [{ amount: 9_000_000_001 }, 'INVALID_AMOUNT', 'Campaign amount is invalid.'],
    [{ recipientRecords: [] }, 'INVALID_HISTORY', 'Reviewed recipient records are required.'],
    [{ recipientRecords: 'everyone' }, 'INVALID_HISTORY', 'Reviewed recipient records are required.'],
    [{ reason: '   ' }, 'INVALID_REASON', 'Campaign reason is required.'],
    [{ recipientRecords: [record({ userId: '' })] }, 'INVALID_ARGUMENT', 'userId is required.'],
    [{ recipientRecords: [record(), record({ transactionId: 2 })] }, 'INVALID_HISTORY', notVerifiable],
    [{ recipientRecords: [record({ transactionId: 0 })] }, 'INVALID_HISTORY', notVerifiable],
    [{ recipientRecords: [record({ transactionId: 'abc' })] }, 'INVALID_HISTORY', notVerifiable],
    [{ recipientRecords: [record({ evidenceHash: 'g'.repeat(64) })] }, 'INVALID_HISTORY', notVerifiable],
    [{ recipientRecords: [record({ evidenceHash: hash.slice(1) })] }, 'INVALID_HISTORY', notVerifiable],
    // The first failing check wins.
    [{ campaignId: '', actorUserId: 'someone-else' }, 'INVALID_ARGUMENT', 'campaignId is required.'],
    [{ amount: 0, reason: '' }, 'INVALID_AMOUNT', 'Campaign amount is invalid.'],
    [{ recipientRecords: [], reason: '' }, 'INVALID_HISTORY', 'Reviewed recipient records are required.'],
    [{ reason: '', recipientRecords: [record({ userId: '' })] }, 'INVALID_REASON', 'Campaign reason is required.'],
  ];
  const before = await ledgerState();

  for (const [overrides, code, message] of cases) {
    await assert.rejects(importOwnerCampaignHistory({ ...valid, ...overrides }),
      (error) => error.name === 'CoinCampaignError' && error.code === code && error.message === message,
      JSON.stringify(overrides));
  }
  assert.deepEqual(await ledgerState(), before);
});

test('a refused record rolls back the whole import, including earlier receipts and the new campaign row', async () => {
  const campaignId = 'import-campaign-atomic';
  const metadata = { ownerCampaignId: campaignId };
  const good = await seedPayment({ guildId: 'guild-atomic', userId: 'import-atomic-good', amount: 20, metadata });
  const bad = await seedPayment({ guildId: 'guild-atomic', userId: 'import-atomic-bad', amount: 20, metadata });
  const before = await ledgerState();

  await assert.rejects(importOwnerCampaignHistory({
    campaignId, actorUserId: OWNER, amount: 20, reason: 'synthetic atomic',
    recipientRecords: [
      { userId: 'import-atomic-good', transactionId: good.id, evidenceHash: evidenceOf(good) },
      { userId: 'import-atomic-bad', transactionId: bad.id, evidenceHash: 'b'.repeat(64) },
    ],
  }), (error) => error.code === 'HISTORY_EVIDENCE_CONFLICT' && error.message === 'Transaction evidence hash has changed.');

  assert.deepEqual(await ledgerState(), before);
  assert.equal(await campaignOf(campaignId), null);
  assert.equal(await receiptOf(campaignId, 'import-atomic-good'), null);
});

test('a batch that repeats a recorded payment imports only the new one and keeps the old receipt', async () => {
  const campaignId = 'import-campaign-mixed';
  const metadata = { ownerCampaignId: campaignId };
  const old = await seedPayment({ guildId: 'guild-mixed', userId: 'import-mixed-old', amount: 15, metadata });
  const fresh = await seedPayment({ guildId: 'guild-mixed', userId: 'import-mixed-new', amount: 15, debt: 4, metadata });
  const oldRecord = { userId: 'import-mixed-old', transactionId: old.id, evidenceHash: evidenceOf(old) };
  await importOwnerCampaignHistory({
    campaignId, actorUserId: OWNER, amount: 15, reason: 'synthetic mixed', recipientRecords: [oldRecord],
  });
  const oldReceipt = await receiptOf(campaignId, 'import-mixed-old');
  const campaign = await campaignOf(campaignId);

  const result = await withSteppingClock(() => importOwnerCampaignHistory({
    campaignId, actorUserId: OWNER, amount: 15, reason: 'synthetic mixed again',
    recipientRecords: [
      oldRecord,
      { userId: 'import-mixed-new', transactionId: fresh.id, evidenceHash: evidenceOf(fresh) },
    ],
  }));

  assert.deepEqual(result, { campaignId, imported: 1, alreadyRecorded: 1 });
  assert.deepEqual(await receiptOf(campaignId, 'import-mixed-old'), oldReceipt);
  assert.deepEqual(await campaignOf(campaignId), campaign);
  const newReceipt = await receiptOf(campaignId, 'import-mixed-new');
  assert.match(newReceipt.created_at, STEPPED);
  assert.deepEqual([newReceipt.debt_offset, newReceipt.net_amount, newReceipt.transaction_id], [4, 11, fresh.id]);
});

test('after an import every campaign read of the reward ledger treats the receipt as a prior grant', async () => {
  const guildId = 'guild-life';
  const campaignId = 'life-campaign';
  const [imported, fresh, legacy] = ['life-imported', 'life-fresh', 'life-legacy'];
  const members = [imported, fresh, legacy];
  const audience = { campaignId, sourceGuildId: guildId, audienceType: 'member', actorUserId: OWNER };
  await setGuildEconomyEnabled(guildId, true, { operatorId: OWNER });
  const payment = await seedPayment({ guildId, userId: imported, amount: 50, metadata: { ownerCampaignId: campaignId } });
  const legacyGrant = await grantRewardOnce(guildId, legacy, 'daily_riddle', 'riddle-2026-10-01', 'answer', 12);
  const plan = (userId) => getOwnerCampaignHistoryReviewPlan({ campaignId, actorUserId: OWNER, userIds: [userId] });
  const review = (userId, source, priorGrant) => reviewOwnerCampaignHistory({
    campaignId, actorUserId: OWNER, reviewId: sha256(`${userId}:${priorGrant}`), sourceSha256: source.sourceSha256,
    decisions: [{
      userId, priorGrant,
      reviewedTransactionIds: source.transactions.map((row) => row.id),
      reviewedLegacyGrantIds: source.legacyGrants.map((row) => row.id),
      reviewedAdminLogIds: source.adminLogs.map((row) => row.id),
      reviewReason: 'synthetic lifecycle review',
    }],
  });
  const conflict = (message) => (error) => error.code === 'HISTORY_EVIDENCE_CONFLICT' && error.message === message;

  const firstPreview = await previewOwnerCampaign({ ...audience, amount: 50, reason: 'synthetic lifecycle', memberIds: members });
  assert.deepEqual([firstPreview.alreadyGranted, firstPreview.pending, firstPreview.historyUnreviewed], [0, 3, 3]);

  // The legacy reward ledger is part of every recipient's review source.
  const legacyPlan = await plan(legacy);
  assert.deepEqual(legacyPlan.legacyGrants.map((row) => [
    row.id, row.guild_id, row.user_id, row.source_type, row.source_id, row.reward_kind, row.amount,
    row.transaction_id,
  ]), [[legacyGrant.grant.id, guildId, legacy, 'daily_riddle', 'riddle-2026-10-01', 'answer', 12,
    legacyGrant.grant.transactionId]]);

  // An imported receipt does not hide the reviewed payment from the review source.
  const beforeImport = await plan(imported);
  assert.deepEqual(beforeImport.transactions.map((row) => row.id), [payment.id]);
  await importOwnerCampaignHistory({
    campaignId, actorUserId: OWNER, amount: 50, reason: 'synthetic lifecycle import',
    recipientRecords: [{ userId: imported, transactionId: payment.id, evidenceHash: evidenceOf(payment) }],
  });
  const afterImport = await plan(imported);
  assert.equal(afterImport.sourceSha256, beforeImport.sourceSha256);
  assert.deepEqual(afterImport.transactions, beforeImport.transactions);

  // A prior-grant decision needs a matching imported receipt.
  await assert.rejects(review(imported, afterImport, false),
    conflict('A transaction names this campaign but has no imported receipt.'));
  await assert.rejects(review(fresh, await plan(fresh), true),
    conflict('Prior grant decision requires a matching imported campaign receipt.'));
  assert.equal((await review(imported, afterImport, true)).reviewed, 1);
  assert.equal((await review(fresh, await plan(fresh), false)).reviewed, 1);

  // Preview and apply count the imported receipt as already granted.
  const secondPreview = await previewOwnerCampaign({ ...audience, amount: 50, reason: 'synthetic lifecycle', memberIds: members });
  assert.deepEqual([secondPreview.alreadyGranted, secondPreview.pending, secondPreview.historyUnreviewed], [1, 2, 1]);
  const applied = await applyOwnerCampaign({ ...audience, previewToken: secondPreview.previewToken, presentMemberIds: members });
  assert.deepEqual(applied, {
    campaignId, audienceType: 'member', total: 3, granted: 1, alreadyGranted: 1, leftGuild: [],
    historyBlocked: [{ userId: legacy, code: 'CAMPAIGN_HISTORY_UNRECONCILED' }], failed: [],
    amountGranted: 50, grossAmountGranted: 50, debtOffset: 0, netAmountGranted: 50, remaining: 0,
  });

  // The campaign's own grant is left out of the review source and is not an imported receipt.
  const freshAfterGrant = await plan(fresh);
  assert.deepEqual(freshAfterGrant.transactions, []);
  await assert.rejects(review(fresh, freshAfterGrant, true),
    conflict('Prior grant decision requires a matching imported campaign receipt.'));
  const thirdPreview = await previewOwnerCampaign({ ...audience, amount: 50, reason: 'synthetic lifecycle', memberIds: members });
  assert.deepEqual([thirdPreview.alreadyGranted, thirdPreview.pending], [2, 1]);
});

test('a receipt that no longer matches its campaign blocks preview, apply and review', async () => {
  const guildId = 'guild-drift';
  const campaignId = 'drift-campaign';
  const userId = 'drift-user';
  const audience = { campaignId, sourceGuildId: guildId, audienceType: 'member', actorUserId: OWNER };
  const payment = await seedPayment({ guildId, userId, amount: 30, metadata: { ownerCampaignId: campaignId } });
  await importOwnerCampaignHistory({
    campaignId, actorUserId: OWNER, amount: 30, reason: 'synthetic drift',
    recipientRecords: [{ userId, transactionId: payment.id, evidenceHash: evidenceOf(payment) }],
  });
  const preview = await previewOwnerCampaign({ ...audience, amount: 30, reason: 'synthetic drift', memberIds: [userId] });
  assert.deepEqual([preview.alreadyGranted, preview.pending], [1, 0]);
  const plan = () => getOwnerCampaignHistoryReviewPlan({ campaignId, actorUserId: OWNER, userIds: [userId] });
  const review = async () => {
    const source = await plan();
    return reviewOwnerCampaignHistory({
      campaignId, actorUserId: OWNER, reviewId: 'c'.repeat(64), sourceSha256: source.sourceSha256,
      decisions: [{
        userId, priorGrant: true, reviewedTransactionIds: source.transactions.map((row) => row.id),
        reviewedLegacyGrantIds: [], reviewedAdminLogIds: [], reviewReason: 'synthetic drift review',
      }],
    });
  };
  assert.equal((await review()).reviewed, 1);
  const editReceipt = (column, value) => withCoinTransaction((api) => api.run(
    `UPDATE reward_grants_v2 SET ${column} = ? WHERE reward_key = ?`, [value, receiptKeyOf(campaignId, userId)]));

  await editReceipt('amount', 29);
  const receiptConflict = (error) => error.code === 'CAMPAIGN_RECEIPT_CONFLICT' &&
    error.message === '活動收據金額與活動設定不同，必須先對帳。';
  await assert.rejects(previewOwnerCampaign({ ...audience, amount: 30, reason: 'synthetic drift', memberIds: [userId] }),
    receiptConflict);
  const current = await getOwnerCampaignPreview(audience);
  await assert.rejects(applyOwnerCampaign({ ...audience, previewToken: current.previewToken, presentMemberIds: [userId] }),
    receiptConflict);
  await assert.rejects(review(), (error) => error.code === 'HISTORY_EVIDENCE_CONFLICT' &&
    error.message === 'Prior grant decision requires a matching imported campaign receipt.');

  await editReceipt('metadata_json', '{broken');
  const invalidMetadata = (error) => error.code === 'HISTORY_EVIDENCE_CONFLICT' &&
    error.message === 'Campaign receipt metadata is invalid.';
  await assert.rejects(plan(), invalidMetadata);
  await assert.rejects(reviewOwnerCampaignHistory({
    campaignId, actorUserId: OWNER, reviewId: 'd'.repeat(64), sourceSha256: 'e'.repeat(64),
    decisions: [{
      userId, priorGrant: true, reviewedTransactionIds: [payment.id], reviewedLegacyGrantIds: [],
      reviewedAdminLogIds: [], reviewReason: 'synthetic drift review',
    }],
  }), invalidMetadata);
});

test('apply counts an imported receipt as granted even before the member has a history review', async () => {
  const guildId = 'guild-unreviewed';
  const campaignId = 'unreviewed-campaign';
  const [imported, waiting] = ['unreviewed-imported', 'unreviewed-waiting'];
  const audience = { campaignId, sourceGuildId: guildId, audienceType: 'member', actorUserId: OWNER };
  const payment = await seedPayment({ guildId, userId: imported, amount: 20, metadata: { ownerCampaignId: campaignId } });
  await importOwnerCampaignHistory({
    campaignId, actorUserId: OWNER, amount: 20, reason: 'synthetic unreviewed import',
    recipientRecords: [{ userId: imported, transactionId: payment.id, evidenceHash: evidenceOf(payment) }],
  });

  // Only the imported member: nothing is pending, so apply pays nobody and blocks nobody.
  const alone = await previewOwnerCampaign({ ...audience, amount: 20, reason: 'synthetic unreviewed', memberIds: [imported] });
  assert.deepEqual([alone.alreadyGranted, alone.pending, alone.historyUnreviewed], [1, 0, 1]);
  const before = await ledgerState();
  assert.deepEqual(await applyOwnerCampaign({ ...audience, previewToken: alone.previewToken, presentMemberIds: [imported] }), {
    campaignId, audienceType: 'member', total: 1, granted: 0, alreadyGranted: 1, leftGuild: [],
    historyBlocked: [], failed: [], amountGranted: 0, grossAmountGranted: 0, debtOffset: 0, netAmountGranted: 0,
    remaining: 0,
  });
  assert.deepEqual(await ledgerState(), before);

  // With an unreviewed member waiting, only that member counts toward the history block.
  const both = await previewOwnerCampaign({ ...audience, amount: 20, reason: 'synthetic unreviewed', memberIds: [imported, waiting] });
  assert.deepEqual([both.alreadyGranted, both.pending, both.historyUnreviewed], [1, 1, 2]);
  await assert.rejects(applyOwnerCampaign({ ...audience, previewToken: both.previewToken, presentMemberIds: [imported, waiting] }),
    (error) => error.code === 'CAMPAIGN_HISTORY_UNRECONCILED' && error.message === '1 人尚未完成歷史發幣核對，不能發幣。');
});

function optionBag(subcommand, values) {
  return {
    getSubcommand: () => subcommand,
    getUser: (name) => values[name] ?? null,
    getRole: (name) => values[name] ?? null,
    getString: (name) => values[name] ?? null,
    getInteger: (name) => values[name] ?? null,
  };
}

function historyInteraction(guild, id, values) {
  const output = { replies: [], edits: [] };
  const interaction = {
    id,
    commandName: 'coin-admin',
    guildId: guild.id,
    guild,
    user: { id: OWNER, tag: 'owner#0001' },
    options: optionBag('history', values),
    deferred: false,
    replied: false,
    inGuild: () => true,
    async reply(payload) {
      this.replied = true;
      output.replies.push(payload);
    },
    async deferReply(payload) {
      this.deferred = true;
      output.defer = payload;
    },
    async editReply(payload) {
      output.edits.push(payload);
    },
  };
  return { interaction, output };
}

test('/coin-admin history import replies with the receipt count and never pays again', async () => {
  const guild = { id: 'guild-command' };
  const campaignId = 'command-campaign';
  const userId = 'command-user';
  await previewOwnerCampaign({
    campaignId, sourceGuildId: guild.id, audienceType: 'member', actorUserId: OWNER,
    amount: 40, reason: 'synthetic command campaign', memberIds: [userId],
  });
  const payment = await seedPayment({ guildId: guild.id, userId, amount: 40, metadata: { ownerCampaignId: campaignId } });
  const history = async (id, values) => {
    const { interaction, output } = historyInteraction(guild, id, {
      user: { id: userId, username: 'Command' }, audience: 'member', 'campaign-id': campaignId, ...values,
    });
    await coinAdmin.execute(interaction);
    assert.deepEqual(output.defer, { ephemeral: true });
    assert.deepEqual(output.replies, []);
    return output.edits[0];
  };
  const tokenOf = async (id) => /單人核對識別碼：([a-f0-9]{64})/u.exec(await history(id, { action: 'plan' }))[1];
  const importWith = (id, token, transactionId) => history(id, {
    action: 'import', 'review-token': token, 'transaction-id': transactionId,
    reason: 'synthetic command import', confirm: '已發對應',
  });
  const walletOf = () => withCoinDatabase((api) => api.get('SELECT balance, total_earned FROM coin_wallets WHERE user_id = ?', [userId]));
  const walletBefore = await walletOf();

  const token = await tokenOf('command-plan-1');
  assert.equal(await importWith('command-import-1', token, payment.id),
    `已對應成員 ${userId} 的舊交易 #${payment.id}，新增收據 1 筆、對帳 1 人；沒有再次入帳。`);
  const receipt = await receiptOf(campaignId, userId);
  assert.deepEqual([receipt.transaction_id, receipt.amount, receipt.debt_offset, receipt.net_amount, receipt.metadata_json], [
    payment.id, 40, 0, 40, JSON.stringify({ imported: true, evidenceHash: evidenceOf(payment) }),
  ]);
  assert.equal(await withCoinDatabase((api) => api.get(`SELECT prior_grant FROM coin_owner_campaign_history_reviews
    WHERE campaign_id = ? AND user_id = ?`, [campaignId, userId]).prior_grant), 1);

  // The import leaves the review source unchanged, so the same token records nothing new.
  assert.equal(await tokenOf('command-plan-2'), token);
  assert.equal(await importWith('command-import-2', token, payment.id),
    `已對應成員 ${userId} 的舊交易 #${payment.id}，新增收據 0 筆、對帳 1 人；沒有再次入帳。`);
  assert.deepEqual(await walletOf(), walletBefore);

  // A second payment for the same member conflicts with the recorded receipt.
  const second = await seedPayment({ guildId: guild.id, userId, amount: 40, metadata: { ownerCampaignId: campaignId } });
  const thirdToken = await tokenOf('command-plan-3');
  assert.notEqual(thirdToken, token);
  const before = await ledgerState();
  assert.equal(await importWith('command-import-3', thirdToken, second.id), '發放結果暫時無法確認，請先核對帳務。');
  assert.deepEqual(await ledgerState(), before);
});
