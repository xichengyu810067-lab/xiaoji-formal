'use strict';

// /bank against a real, isolated coin database: the refusals members read are fixed Chinese
// sentences, never the English text of an internal error. Only Discord is faked.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-bank-language-'));
process.env.COIN_DB_PATH = path.join(root, 'bank-language.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';

// /bank rate-history is for administrators. This file runs in its own process, so the permission
// check is replaced with a stand-in before /bank loads it.
require('../src/utils/moderation').ensureModerationAccess = async () => ({ ok: true });

const bankCommand = require('../src/commands/bank');
const { initializeNewCoinDatabase, resetCoinDatabaseForTests } = require('../src/services/coinDatabase');
const { adjustPlayerBalance } = require('../src/services/coinService');
const { cancelFixedDeposit, createFixedDeposit, setDemandRate } = require('../src/services/bankService');
const { GameError, applyNumberMatchAction, applyTetrisAction, initialState } = require('../src/systems/games/soloGameRules');

const GUILD_ID = 'bank-language-guild';
const USER_ID = 'bank-language-user';
const NOT_FOUND = '找不到這筆定存，請用 /bank fixed-list 確認定存 ID。';
// Latin letters outside a slash-command reference (and the word ID, which the Chinese interface
// uses too) mean an English sentence reached the member.
const withoutCommandNames = (text) => text.replace(/\/bank [a-z-]+/gu, '').replace(/\bID\b/gu, '');

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  await adjustPlayerBalance(GUILD_ID, USER_ID, {
    action: 'add', amount: 5000, operatorId: 'fixture-admin', reason: 'bank language fixture',
  });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

async function runBank(subcommand, integers = {}, userId = USER_ID) {
  const replies = [];
  const interaction = {
    commandName: 'bank',
    guildId: GUILD_ID,
    user: { id: userId },
    replied: false,
    deferred: false,
    inGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getInteger: (name) => integers[name] ?? null,
      getString: () => null,
    },
    async reply(payload) {
      replies.push(payload);
      interaction.replied = true;
    },
    async followUp(payload) {
      replies.push(payload);
    },
  };
  await bankCommand.execute(interaction);
  assert.equal(replies.length, 1, `${subcommand} answers once`);
  return replies[0];
}

test('/bank fixed-cancel and fixed-claim with an unknown id answer one fixed Chinese sentence', async () => {
  for (const subcommand of ['fixed-cancel', 'fixed-claim']) {
    const reply = await runBank(subcommand, { 'fixed-id': 987654 });
    assert.deepEqual(reply, { content: NOT_FOUND, ephemeral: true }, subcommand);
  }
});

test("someone else's deposit is not found either, in the same words", async () => {
  const deposit = await createFixedDeposit(GUILD_ID, USER_ID, { amount: 1000, termDays: 7, source: 'wallet' });
  const reply = await runBank('fixed-cancel', { 'fixed-id': deposit.id }, 'bank-language-stranger');
  assert.deepEqual(reply, { content: NOT_FOUND, ephemeral: true });
});

test('a deposit that is not due yet, or already cancelled, is refused in Chinese', async () => {
  const deposit = await createFixedDeposit(GUILD_ID, USER_ID, { amount: 1000, termDays: 14, source: 'wallet' });
  const early = await runBank('fixed-claim', { 'fixed-id': deposit.id });
  assert.equal(early.content, '這筆定存尚未到期；如要提前拿回，請改用 /bank fixed-cancel 解約。');

  await runBank('fixed-cancel', { 'fixed-id': deposit.id });
  const again = await runBank('fixed-cancel', { 'fixed-id': deposit.id });
  assert.equal(again.content, '這筆定存已經解約了。');
});

test('not enough coins in the wallet or the bank says so in Chinese, with the amounts', async () => {
  const withdraw = await runBank('withdraw', { amount: 50 });
  assert.deepEqual(withdraw, {
    content: '活存餘額不足，無法領出。\n目前活存：0 吉幣\n需要金額：50 吉幣',
    ephemeral: true,
  });

  const deposit = await runBank('deposit', { amount: 9_000_000 });
  assert.match(deposit.content, /^錢包吉幣不足，無法存入活存。\n目前餘額：[\d,]+ 吉幣\n需要金額：9,000,000 吉幣$/u);
});

// The source itself: every refusal the bank service can raise is a Chinese sentence. A literal
// message, or the constant it names, is checked, so a new English message fails here.
test('every bank service refusal is written in Chinese', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'systems', 'economy', 'bankService.js'), 'utf8');
  const pattern = /new CoinServiceError\(\s*'([A-Z_]+)',\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[A-Z_]+)/gu;
  const found = [...source.matchAll(pattern)];
  assert.ok(found.length >= 20, `found ${found.length} refusals`);
  for (const [, code, argument] of found) {
    let text = argument;
    if (/^[A-Z_]+$/u.test(argument)) {
      const constant = new RegExp(`const ${argument} = '((?:[^'\\\\]|\\\\.)*)';`, 'u').exec(source);
      assert.ok(constant, `${code} names a constant that is defined: ${argument}`);
      text = constant[1];
    }
    const visible = withoutCommandNames(text.replace(/\$\{[^}]*\}/gu, ''));
    assert.match(visible, /\p{Script=Han}/u, `${code} is Chinese: ${text}`);
    assert.doesNotMatch(visible, /[A-Za-z]/u, `${code} has no English: ${text}`);
  }
});

// Two solo-game refusals a member can reach by typing: a wide piece in the last column, and the
// same cell twice. The Discord runtime shows these messages as they are.
test('solo game refusals a member can reach are Chinese', () => {
  const isChineseRefusal = (error) => error instanceof GameError && error.code === 'INVALID_ACTION' &&
    /\p{Script=Han}/u.test(error.message) && !/[A-Za-z]/u.test(error.message);
  assert.throws(() => applyTetrisAction(initialState('tetris', 'normal', 'synthetic-seed'),
    { type: 'lock', column: 9, rotation: 0 }), isChineseRefusal);
  assert.throws(() => applyNumberMatchAction(initialState('number-match', 'easy'),
    { type: 'pair', first: 0, second: 0 }), isChineseRefusal);
});

// A deposit's status and source, and the rate names, are shown in Chinese, not as the stored codes
// (active, wallet, demand, fixed_30), and the rate history has no English words between its fields.
test('/bank shows deposit statuses, sources and rate names in Chinese', async () => {
  const created = await runBank('fixed-create', { amount: 1000, 'term-days': 30 });
  assert.match(created.content, /^\*\*定存建立成功\*\*\n#\d+ <@bank-language-user>\n/u);
  assert.ok(created.content.includes('狀態：存放中｜來源：錢包'), created.content);

  const listed = await runBank('fixed-list');
  assert.ok(listed.content.includes('狀態：存放中｜來源：錢包'), listed.content);
  for (const reply of [created, listed]) {
    assert.doesNotMatch(reply.content, /active|matured|claimed|cancelled|wallet|N\/A/u);
  }

  await setDemandRate(GUILD_ID, 0.05, { operatorId: 'bank-language-owner', reason: '活動', durationDays: 3 });
  const rates = await runBank('rate-list');
  assert.match(rates.content, /\n活動利率：活存 到 <t:\d+:F>$/u);
  const history = await runBank('rate-history');
  assert.match(history.content, /^\*\*利率調整紀錄\*\*\n#\d+ 活存：[\d.]+% -> 0\.0500%｜操作者 <@bank-language-owner>｜<t:\d+:F>｜活動到 <t:\d+:F>$/mu);
  for (const reply of [rates, history]) assert.doesNotMatch(reply.content, /demand|fixed_| by | at /u);
});

// A cancelled deposit no longer earns or pays anything, so the list must not quote an estimate or a
// claimable total for it. The active deposit beside it still shows both.
test('/bank fixed-list leaves the estimate and claimable lines out of a cancelled deposit', async () => {
  const cancelUser = 'bank-cancelled-display-user';
  await adjustPlayerBalance(GUILD_ID, cancelUser, {
    action: 'add', amount: 5000, operatorId: 'fixture-admin', reason: 'cancelled display fixture',
  });
  const active = await createFixedDeposit(GUILD_ID, cancelUser, { amount: 1000, termDays: 30, source: 'wallet' });
  const cancelled = await createFixedDeposit(GUILD_ID, cancelUser, { amount: 1000, termDays: 30, source: 'wallet' });
  await cancelFixedDeposit(GUILD_ID, cancelUser, cancelled.id);

  const listed = await runBank('fixed-list', {}, cancelUser);
  const blockOf = (id) => listed.content.split('\n\n').find((part) => part.startsWith(`#${id} `));
  const activeBlock = blockOf(active.id);
  const cancelledBlock = blockOf(cancelled.id);
  assert.ok(activeBlock, listed.content);
  assert.ok(cancelledBlock, listed.content);
  assert.match(activeBlock, /預估利息：[\d,]+ 吉幣｜可領合計：[\d,]+ 吉幣$/mu);
  assert.ok(cancelledBlock.includes('狀態：已解約'), cancelledBlock);
  assert.doesNotMatch(cancelledBlock, /預估利息|可領合計/u);
});

// An admin reply names the member by the server display name, then the global name, then the account
// tag. The balance card gives the member as a mention only, never with the raw user ID after it.
async function runBankForMember(subcommand, user, member) {
  const replies = [];
  const interaction = {
    commandName: 'bank',
    guildId: GUILD_ID,
    user: { id: 'bank-language-owner' },
    // Looking up another user is only for a member of this server, so the member lookup finds this one.
    guild: { members: { fetch: async (id) => ({ id }) } },
    replied: false,
    deferred: false,
    inGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getUser: (name) => (name === 'user' ? user : null),
      getMember: (name) => (name === 'user' ? member : null),
      getInteger: () => null,
      getString: () => null,
    },
    async reply(payload) {
      replies.push(payload);
      interaction.replied = true;
    },
  };
  await bankCommand.execute(interaction);
  assert.equal(replies.length, 1, `${subcommand} answers once`);
  return replies[0];
}

test('/bank fixed-user and balance-user name the member by display name, not by account tag or raw ID', async () => {
  const memberId = 'bank-named-member';
  await adjustPlayerBalance(GUILD_ID, memberId, {
    action: 'add', amount: 5000, operatorId: 'fixture-admin', reason: 'named member fixture',
  });
  await createFixedDeposit(GUILD_ID, memberId, { amount: 1000, termDays: 30, source: 'wallet' });
  const user = { id: memberId, tag: 'account-tag#0001', username: 'account-tag', globalName: '全域名稱' };

  const withNickname = await runBankForMember('fixed-user', user, { displayName: '伺服器暱稱' });
  assert.equal(withNickname.content.split('\n')[0], '**伺服器暱稱 的定存列表**', withNickname.content);
  const withoutMember = await runBankForMember('fixed-user', user, null);
  assert.equal(withoutMember.content.split('\n')[0], '**全域名稱 的定存列表**', withoutMember.content);

  const balance = await runBankForMember('balance-user', user, null);
  assert.ok(balance.content.includes(`使用者：<@${memberId}>\n`), balance.content);
  assert.equal(balance.content.includes(`(${memberId})`), false, balance.content);
  assert.doesNotMatch(balance.content, /account-tag/u);
});
