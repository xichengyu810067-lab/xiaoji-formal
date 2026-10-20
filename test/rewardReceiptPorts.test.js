const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Contract of the reward ledger's transaction ports. Each port issues
// exactly one statement on the api it is handed, answers synchronously, and never opens,
// commits or rolls back a transaction. No database is opened: the api here only records.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-reward-ports-'));
process.env.COIN_DB_PATH = path.join(root, 'never-opened.sqlite');

const ledger = require('../src/services/featurePlatformService');

test.after(() => {
  assert.equal(fs.existsSync(process.env.COIN_DB_PATH), false);
  fs.rmSync(root, { recursive: true, force: true });
});

const squash = (sql) => sql.replace(/\s+/g, ' ').trim();

function recordingApi(answer) {
  const calls = [];
  const record = (method) => (sql, params) => {
    calls.push({ method, sql: squash(sql), params });
    return answer;
  };
  return { calls, api: { get: record('get'), all: record('all'), run: record('run') } };
}

const ROW = Object.freeze({ stored: 'row' });
const ROWS = Object.freeze([ROW]);
const OWNER_CAMPAIGN_RECEIPT = "FROM reward_grants_v2 WHERE kind = 'owner-campaign' AND canonical_source_id = ? " +
  "AND reward_kind = 'campaign' AND user_id = ?";
const importedReceipt = Object.freeze({
  rewardKey: 'reward:v1:key', canonicalSourceId: 'campaign-1', userId: 'user-1', sourceGuildId: 'guild-1',
  amount: 100, payloadHash: 'p'.repeat(64), metadataJson: '{"imported":true}', debtOffset: 30, netAmount: 70,
  transactionId: 7, createdAt: '2026-10-02T00:00:00.000Z',
});

const cases = [
  ['getRewardReceiptByKeyWithApi', ['reward:v1:key'], ROW, ROW,
    'get', 'SELECT * FROM reward_grants_v2 WHERE reward_key = ?', ['reward:v1:key']],
  ['getRewardReceiptDebtSplitByKeyWithApi', ['reward:v1:key'], ROW, ROW,
    'get', 'SELECT debt_offset, net_amount FROM reward_grants_v2 WHERE reward_key = ?', ['reward:v1:key']],
  ['getOwnerCampaignReceiptWithApi', ['campaign-1', 'user-1'], ROW, ROW,
    'get', `SELECT * ${OWNER_CAMPAIGN_RECEIPT}`, ['campaign-1', 'user-1']],
  ['getOwnerCampaignReceiptTransactionWithApi', ['campaign-1', 'user-1'], ROW, ROW,
    'get', `SELECT transaction_id, metadata_json ${OWNER_CAMPAIGN_RECEIPT}`, ['campaign-1', 'user-1']],
  ['hasOwnerCampaignReceiptWithApi', ['campaign-1', 'user-1'], { 1: 1 }, true,
    'get', `SELECT 1 ${OWNER_CAMPAIGN_RECEIPT}`, ['campaign-1', 'user-1']],
  ['hasOwnerCampaignReceiptWithApi', ['campaign-1', 'user-1'], null, false,
    'get', `SELECT 1 ${OWNER_CAMPAIGN_RECEIPT}`, ['campaign-1', 'user-1']],
  ['listOwnerCampaignReceiptAmountsWithApi', ['campaign-1'], ROWS, ROWS, 'all',
    "SELECT user_id, amount FROM reward_grants_v2 WHERE kind = 'owner-campaign' AND canonical_source_id = ? " +
    "AND reward_kind = 'campaign'", ['campaign-1']],
  ['listLegacyRewardGrantsByUserWithApi', ['user-1'], ROWS, ROWS,
    'all', 'SELECT * FROM reward_grants WHERE user_id = ? ORDER BY id', ['user-1']],
  ['importOwnerCampaignReceiptWithApi', [importedReceipt], undefined, undefined, 'run',
    'INSERT INTO reward_grants_v2 (reward_key, operation_id, kind, canonical_source_id, reward_kind, user_id, ' +
    'source_guild_id, amount, payload_hash, metadata_json, debt_offset, net_amount, transaction_id, created_at) ' +
    "VALUES (?, ?, 'owner-campaign', ?, 'campaign', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ['reward:v1:key', 'reward:v1:key', 'campaign-1', 'user-1', 'guild-1', 100, 'p'.repeat(64),
      '{"imported":true}', 30, 70, 7, '2026-10-02T00:00:00.000Z']],
];

for (const [port, args, answer, expected, method, sql, params] of cases) {
  test(`${port} issues one statement on the given api (stored answer ${JSON.stringify(answer)})`, () => {
    const { calls, api } = recordingApi(answer);

    const result = ledger[port](api, ...args);

    // A plain value, not a promise, so the port can run inside the caller's transaction.
    assert.equal(typeof result?.then, 'undefined');
    assert.equal(result, expected);
    assert.deepEqual(calls, [{ method, sql, params }]);
  });
}

test('the campaign and solo game modules no longer name the reward ledger tables', () => {
  for (const file of ['src/systems/economy/coinCampaignService.js', 'src/systems/games/soloSessionService.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /reward_grants/u, file);
  }
});
