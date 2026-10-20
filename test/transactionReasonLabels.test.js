'use strict';

// Transaction and rate-change reasons read in Chinese on the admin screens. New rows are written in
// Chinese; rows older versions wrote keep their fixed English reasons and are named in Chinese when
// shown, so an old row and a new row of the same kind read the same. A real, isolated coin database;
// only Discord and the permission check are stand-ins.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-transaction-reasons-'));
process.env.COIN_DB_PATH = path.join(root, 'transaction-reasons.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';

// The admin checks are stand-ins; this file runs in its own process, and the commands load after this.
require('../src/utils/moderation').ensureModerationAccess = async () => ({ ok: true });

const economyCommand = require('../src/commands/economy');
const coinAdminCommand = require('../src/commands/coin-admin');
const { initializeNewCoinDatabase, resetCoinDatabaseForTests, withCoinTransaction } = require('../src/services/coinDatabase');
const { adjustPlayerBalance, TransactionType } = require('../src/services/coinService');
const { deposit, getBankRates, setDemandRate } = require('../src/services/bankService');
const { mutateWalletWithApi } = require('../src/services/coinWalletService');
const { describeTransactionReason } = require('../src/systems/economy/transactionReasons');

const GUILD_ID = 'reason-guild';
const USER_ID = 'reason-member';
const LEGACY_ROW_TIME = '2026-01-01T00:00:00.000Z';

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  await adjustPlayerBalance(GUILD_ID, USER_ID, {
    action: 'add', amount: 5000, operatorId: 'reason-admin', reason: '測試資料',
  });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

async function run(command, commandName, subcommand, { strings = {}, users = {} } = {}) {
  const replies = [];
  const interaction = {
    commandName,
    id: `reason-${Math.random()}`,
    guildId: GUILD_ID,
    guild: { id: GUILD_ID, name: 'Reason Guild', members: { fetch: async () => null } },
    user: { id: 'reason-admin' },
    replied: false,
    deferred: false,
    inGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => strings[name] ?? null,
      getUser: (name) => users[name] ?? null,
      getRole: () => null,
      getInteger: () => null,
    },
    async reply(payload) { replies.push(payload); interaction.replied = true; },
    async followUp(payload) { replies.push(payload); },
  };
  await command.execute(interaction);
  assert.equal(replies.length, 1);
  return replies[0].content;
}

const countOf = (text, needle) => text.split(needle).length - 1;

test('the fixed English reasons of older versions are named in Chinese, and anything else is kept', () => {
  const cases = {
    'bank deposit': '存入活存',
    'bank withdraw': '從活存領出',
    '30-day fixed deposit created': '建立 30 天定存',
    'fixed deposit principal returned': '定存到期返還本金',
    'fixed deposit interest': '定存到期利息',
    'fixed deposit principal returned after cancellation': '定存解約返還本金',
    'fixed deposit cancellation interest': '定存解約利息',
    'bank interest (2026-09-30)': '活存利息（2026-09-30）',
    'event expired': '活動利率到期',
    'event expired auto restore': '活動利率到期，自動恢復',
    'default rate': '預設利率',
    'initial price': '初始價格',
    'feature reward: participation': '參與獎勵',
    'feature reward: correct_answer': '答對獎勵',
    'feature reward: completion': '遊戲完成獎勵',
    'work-settlement:salary': '工作薪資結算',
    'game:completion': '遊戲完成獎勵',
    'owner-campaign:campaign': '活動發幣',
  };
  for (const [stored, shown] of Object.entries(cases)) assert.equal(describeTransactionReason(stored), shown, stored);
  for (const kept of ['管理員手動補發', 'extension-kind:custom', 'feature reward: unknown_kind', 'Bank Deposit', '']) {
    assert.equal(describeTransactionReason(kept), kept);
  }
  assert.equal(describeTransactionReason(null), '');
});

test('an old English row and a new row of the same kind read the same on both admin screens', async () => {
  // A deposit as an older version recorded it, then a deposit made now.
  await withCoinTransaction((api) => mutateWalletWithApi(api, {
    guildId: GUILD_ID, userId: USER_ID, type: TransactionType.BANK_DEPOSIT, balanceDelta: -100,
    operatorId: null, reason: 'bank deposit', metadata: {}, createdAt: LEGACY_ROW_TIME,
  }));
  await deposit(GUILD_ID, USER_ID, 200);
  const stored = await withCoinTransaction((api) => api.all(
    "SELECT reason FROM coin_transactions WHERE type = 'bank_deposit' ORDER BY created_at ASC"));
  assert.deepEqual(stored.map((row) => row.reason), ['bank deposit', '存入活存']);

  const audit = await run(economyCommand, 'economy', 'audit', { strings: { type: 'transactions' } });
  const history = await run(coinAdminCommand, 'coin-admin', 'history', { users: { user: { id: USER_ID, username: 'member' } } });
  // Each deposit line names the type and then the reason, both 存入活存, for the old row and the new.
  for (const screen of [audit, history]) {
    const lines = screen.split('\n').filter((line) => line.includes('存入活存'));
    assert.equal(lines.length, 2, screen);
    for (const line of lines) assert.equal(countOf(line, '存入活存'), 2, line);
    assert.doesNotMatch(screen, /bank deposit/u);
  }
});

test('rate changes written now, and an old English rate row, read the same in the rate audit', async () => {
  await setDemandRate(GUILD_ID, 0.05, { operatorId: 'reason-owner', reason: '週年活動', durationDays: 1 });
  await withCoinTransaction((api) => {
    api.run("UPDATE coin_bank_rates_global SET event_ends_at = ? WHERE rate_key = 'demand'", ['2026-01-02T00:00:00.000Z']);
    api.run(`INSERT INTO coin_rate_history_global
      (operator_id, rate_key, old_rate, new_rate, reason, is_event, event_ends_at, source_guild_id, created_at)
      VALUES ('system', 'fixed_7', 0.004, 0.0035, 'event expired auto restore', 0, NULL, NULL, ?)`, [LEGACY_ROW_TIME]);
  });
  await getBankRates(GUILD_ID);
  const stored = await withCoinTransaction((api) => api.all(
    "SELECT reason FROM coin_rate_history_global WHERE operator_id = 'system' ORDER BY created_at ASC"));
  assert.deepEqual(stored.map((row) => row.reason), ['event expired auto restore', '活動利率到期，自動恢復']);

  const rates = await run(economyCommand, 'economy', 'audit', { strings: { type: 'rates' } });
  assert.equal(countOf(rates, '｜活動利率到期，自動恢復｜'), 2, rates);
  assert.ok(rates.includes('｜週年活動｜'), rates);
  assert.doesNotMatch(rates, /event expired|demand|fixed_/u);
});

// The writers themselves: none of the fixed English reasons is written any more. (A reward paid through
// the reward coordinator still stores its "<kind>:<reward kind>" key, which the reviewed venue-work
// snapshots pin; it is named in Chinese when shown, as the test above checks.)
test('the code that records transactions and rate changes writes no fixed English reasons', () => {
  const files = [
    ['src', 'systems', 'economy', 'bankService.js'],
    ['src', 'systems', 'economy', 'luxuryService.js'],
    ['src', 'services', 'featurePlatformService.js'],
  ];
  const english = /bank deposit|bank withdraw|fixed deposit (?:created|principal|interest|cancellation)|day fixed deposit|bank interest \(|event expired|default rate|initial price|feature reward/u;
  for (const parts of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
    assert.doesNotMatch(source, english, parts.join('/'));
    assert.doesNotMatch(source, /reason: '[A-Za-z]/u, parts.join('/'));
  }
});
