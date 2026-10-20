'use strict';

// The /economy audit lines and the /coin-admin history lines name transaction types, statuses and
// rates in Chinese. The stored values are internal codes (daily_checkin, matured, fixed_30) that an
// admin should not have to decode. The services are stand-ins; only the presentation is under test.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  formatFixedDepositStatus,
  formatLoanStatus,
  formatRateKey,
  formatTransactionType,
  formatWorkStatus,
} = require('../src/utils/coinPresentation');
const { TransactionType } = require('../src/services/coinService');

const src = (...parts) => path.join(__dirname, '..', 'src', ...parts);
const CREATED_AT = '2026-10-01T04:00:00.000Z';

// Replaces some exports of the given modules, loads the command fresh so it takes the stand-ins,
// and puts everything back after the test.
function loadCommand(t, commandFile, patches) {
  const restores = [];
  for (const [modulePath, updates] of Object.entries(patches)) {
    const moduleExports = require(modulePath);
    for (const [key, value] of Object.entries(updates)) {
      const original = moduleExports[key];
      moduleExports[key] = value;
      restores.push(() => { moduleExports[key] = original; });
    }
  }
  const commandPath = require.resolve(commandFile);
  delete require.cache[commandPath];
  const command = require(commandPath);
  t.after(() => {
    delete require.cache[commandPath];
    restores.reverse().forEach((restore) => restore());
  });
  return command;
}

function slash({ commandName, subcommand, strings = {}, users = {}, members = {} }) {
  const replies = [];
  const interaction = {
    commandName,
    id: 'synthetic-interaction',
    guildId: 'audit-guild',
    user: { id: 'audit-admin' },
    guild: { id: 'audit-guild', name: 'Audit Guild', members: { fetch: async () => null } },
    replied: false,
    deferred: false,
    inGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => strings[name] ?? null,
      getUser: (name) => users[name] ?? null,
      getMember: (name) => members[name] ?? null,
      getRole: () => null,
      getInteger: () => null,
    },
    async reply(payload) {
      replies.push(payload);
      interaction.replied = true;
    },
    async followUp(payload) {
      replies.push(payload);
    },
  };
  return { interaction, replies };
}

const allowAdmin = { [src('utils', 'moderation.js')]: { ensureModerationAccess: async () => ({ ok: true }) } };

test('every stored transaction type has a Chinese name, and an unknown one is shown as stored', () => {
  for (const type of Object.values(TransactionType)) {
    const label = formatTransactionType(type);
    assert.match(label, /\p{Script=Han}/u, type);
    assert.doesNotMatch(label, /[A-Za-z]/u, type);
  }
  assert.equal(formatTransactionType('daily_checkin'), '每日簽到');
  assert.equal(formatTransactionType('extension_made_type'), 'extension_made_type');
  assert.equal(formatFixedDepositStatus('matured'), '已到期，可領取');
  assert.equal(formatRateKey('demand'), '活存');
  assert.equal(formatRateKey('fixed_30'), '30 天定存');
  assert.equal(formatWorkStatus('system_completed'), '小吉接手完成');
  // Casino loans: /casino shows a loan after borrowing or repaying (the owner's debt status, a private command, is
  // checked the same way in the private test suite).
  assert.equal(formatLoanStatus('active'), '借款中');
  assert.equal(formatLoanStatus('repaid'), '已還清');
  for (const file of ['casino.js']) {
    const source = require('node:fs').readFileSync(src('commands', file), 'utf8');
    assert.doesNotMatch(source, /`狀態：\$\{(status\.)?loan\.status\}`/u, file);
    assert.doesNotMatch(source, /沒有 active/u, file);
  }
});

test('/economy audit shows Chinese names for transaction types, statuses and rates', async (t) => {
  const command = loadCommand(t, src('commands', 'economy.js'), {
    ...allowAdmin,
    [src('services', 'coinService.js')]: {
      getAllTransactions: async () => [{
        id: 7, userId: 'member-1', type: 'daily_checkin', amount: 120,
        balanceBefore: 0, balanceAfter: 120, reason: '每日簽到', createdAt: CREATED_AT,
      }],
      getAllPurchaseHistory: async () => [{
        id: 3, userId: 'member-1', itemName: '徽章', quantity: 1, totalPrice: 50,
        itemType: 'collectible', status: 'active', expiresAt: null, createdAt: CREATED_AT,
      }],
    },
    [src('services', 'bankService.js')]: {
      listFixedDeposits: async () => [{
        id: 5, userId: 'member-1', principal: 1000, termDays: 30, rate: 0.02, expectedInterest: 20,
        status: 'active', displayStatus: 'matured', maturityAt: CREATED_AT,
      }],
      getRateHistory: async () => [
        { id: 1, rateKey: 'fixed_30', termDays: 30, oldRate: 0.02, newRate: 0.03, operatorId: 'owner',
          isEvent: false, eventEndsAt: null, reason: '調整', createdAt: CREATED_AT },
        { id: 2, rateKey: 'demand', termDays: null, oldRate: 0.0003, newRate: 0.0004, operatorId: 'owner',
          isEvent: false, eventEndsAt: null, reason: '調整', createdAt: CREATED_AT },
      ],
    },
    [src('services', 'workService.js')]: {
      listWorkTasks: async () => [{
        id: 9, userId: 'member-1', jobName: '廚師', status: 'system_completed',
        description: '做一份餐點', taskType: 'venue_meal', createdAt: CREATED_AT,
      }],
    },
  });

  const expectations = {
    transactions: { shows: '｜每日簽到｜', hides: /daily_checkin/u },
    purchases: { shows: '｜有效｜', hides: /｜active｜/u },
    fixed: { shows: '狀態 已到期，可領取', hides: /matured/u },
    rates: { shows: '#1｜30 天定存｜', hides: /fixed_30|demand/u },
    tasks: { shows: '｜小吉接手完成｜', hides: /system_completed/u },
  };
  for (const [type, { shows, hides }] of Object.entries(expectations)) {
    const { interaction, replies } = slash({ commandName: 'economy', subcommand: 'audit', strings: { type } });
    await command.execute(interaction);
    assert.equal(replies.length, 1, type);
    assert.equal(replies[0].ephemeral, true, type);
    assert.ok(replies[0].content.includes(shows), `${type}: ${replies[0].content}`);
    assert.doesNotMatch(replies[0].content, hides, type);
  }
  const rates = slash({ commandName: 'economy', subcommand: 'audit', strings: { type: 'rates' } });
  await command.execute(rates.interaction);
  assert.ok(rates.replies[0].content.includes('#2｜活存｜'), rates.replies[0].content);
});

test('/coin-admin history names the transaction type in Chinese', async (t) => {
  const command = loadCommand(t, src('commands', 'coin-admin.js'), {
    ...allowAdmin,
    [src('services', 'coinService.js')]: {
      getTransactions: async () => [{
        id: 11, type: 'bank_deposit', amount: -300, balanceBefore: 500, balanceAfter: 200,
        reason: '存入', createdAt: CREATED_AT,
      }],
    },
  });
  const target = { id: 'member-1', username: 'member', globalName: '成員甲' };
  const { interaction, replies } = slash({ commandName: 'coin-admin', subcommand: 'history', users: { user: target } });
  await command.execute(interaction);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /^\*\*成員甲 最近交易紀錄\*\*\n#11 <t:\d+:R> 存入活存 /u);
  assert.doesNotMatch(replies[0].content, /bank_deposit/u);
});

// The owner replies for remove, set, reset-user and history name the member the same way: the server
// display name when the member is known, otherwise the global name. The raw user ID never appears.
test('/coin-admin remove, set, reset-user and history name the member by display name', async (t) => {
  const command = loadCommand(t, src('commands', 'coin-admin.js'), {
    ...allowAdmin,
    [src('utils', 'ownerOnly.js')]: { ensureBotOwner: async () => true },
    [src('services', 'coinService.js')]: {
      adjustPlayerBalance: async () => ({ before: 500, amount: 50, after: 450, alreadyApplied: false }),
      resetPlayerData: async () => ({ before: 500, after: 0 }),
      getTransactions: async () => [{
        id: 12, type: 'admin_remove', amount: -50, balanceBefore: 500, balanceAfter: 450,
        reason: '扣除', createdAt: CREATED_AT,
      }],
    },
  });
  const user = { id: 'member-9', username: 'member9', globalName: '全域名稱' };
  const named = { displayName: '伺服器暱稱', user };
  const cases = [
    { subcommand: 'remove', strings: { reason: '測試' }, reply: /^扣幣完成。\n目標：伺服器暱稱\n/u },
    { subcommand: 'set', strings: { reason: '測試' }, reply: /^設定餘額完成。\n目標：伺服器暱稱\n/u },
    { subcommand: 'reset-user', strings: { confirm: 'RESET', reason: '測試' }, reply: /\n目標：伺服器暱稱\n/u },
    { subcommand: 'history', strings: {}, reply: /^\*\*伺服器暱稱 最近交易紀錄\*\*\n#12 /u },
  ];
  for (const { subcommand, strings, reply } of cases) {
    const replyCase = slash({ commandName: 'coin-admin', subcommand, strings, users: { user }, members: { user: named } });
    await command.execute(replyCase.interaction);
    assert.equal(replyCase.replies.length, 1, subcommand);
    assert.match(replyCase.replies[0].content, reply, subcommand);
    assert.doesNotMatch(replyCase.replies[0].content, /member-9/u, subcommand);
  }

  // Without a server member (the target has left, or the option carried no member) the global name is used.
  const unnamed = slash({ commandName: 'coin-admin', subcommand: 'set', strings: { reason: '測試' }, users: { user } });
  await command.execute(unnamed.interaction);
  assert.match(unnamed.replies[0].content, /\n目標：全域名稱\n/u);
});

// A casino room booking is written to the chip ledger as the "lodging" entry type. /exchange history
// lists those entries, so the type is named in Chinese there.
test('/exchange history names a lodging chip entry in Chinese', async (t) => {
  const command = loadCommand(t, src('commands', 'exchange.js'), {
    [src('services', 'chipService.js')]: {
      getChipHistory: async () => [{
        id: 21, entryType: 'lodging', amount: -300, balanceBefore: 800, balanceAfter: 500,
        coinAmount: 0, fee: 0, reason: '賭場住宿：標準房', createdAt: CREATED_AT,
      }],
    },
  });
  const { interaction, replies } = slash({ commandName: 'exchange', subcommand: 'history' });
  await command.execute(interaction);
  assert.equal(replies.length, 1);
  assert.ok(replies[0].content.includes('#21｜住宿｜-300 籌碼｜'), replies[0].content);
  assert.doesNotMatch(replies[0].content, /lodging/u);
});
