'use strict';

// Attack tests for the values a command is given that Discord's own client would have stopped: an ID that is not a
// snowflake, a number outside the range an option declares, a text longer than its limit or of a shape nobody asked
// for. Discord checks these before a command runs; a hand-made interaction does not, so each handler and the
// service behind it have to refuse them by themselves, and the refusal has to leave nothing behind.
//
// Everything runs through the real interaction handler, the real commands, the real services and a real coin database
// (test/support/attackSession.js). Every refusal is held to the same bar: the handler does not throw, the user gets
// one answer, the interaction count is the only table that moves, no file changes and no wallet moves.
//
// A plain test that passes is a defence that held. A test marked todo is a gap that is reported and not fixed here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ApplicationCommandOptionType } = require('discord.js');

const attack = require('./support/attackSession');

const session = attack.createAttackSession({ prefix: 'xiaoji-attack-values-' });

const coinService = require('../src/services/coinService');
const chipService = require('../src/services/chipService');
const bankService = require('../src/services/bankService');
const { withCoinDatabase } = require('../src/services/coinDatabase');
const { COMMAND_CATALOG, getSubcommandAudience } = require('../website/commandCatalog');

const { IDS } = session;
const HOME = IDS.approvedGuild;
const FALLBACK = '系統暫時無法處理吉幣資料，請稍後再試。';

test.before(async () => {
  await session.open();
  await coinService.setGuildEconomyEnabled(HOME, true, { operatorId: IDS.owner });
  for (const userId of [IDS.member, IDS.target, IDS.owner]) {
    await coinService.adjustPlayerBalance(HOME, userId, {
      action: 'add', amount: 2_000_000, operatorId: IDS.owner, reason: '數值攻擊測試初始資金', operationId: `attack-values-seed-${userId}`,
    });
    await chipService.buyChips(HOME, userId, 200_000);
    await bankService.deposit(HOME, userId, 100_000);
  }
});

test.after(() => session.close());

async function wallets() {
  return withCoinDatabase((api) => api.all(
    'SELECT user_id, balance, total_earned, total_spent FROM coin_wallets ORDER BY user_id'
  ));
}

async function ledgerTotals() {
  return withCoinDatabase((api) => ({
    wallets: api.all('SELECT user_id, balance FROM coin_wallets ORDER BY user_id'),
    transactions: api.all('SELECT user_id, SUM(amount) AS total FROM coin_transactions GROUP BY user_id ORDER BY user_id'),
    chips: api.all('SELECT user_id, balance FROM chip_accounts_global ORDER BY user_id'),
    bank: api.all('SELECT user_id, balance FROM coin_bank_accounts_global ORDER BY user_id'),
  }));
}

// A user object Discord would never deliver: its ID is whatever the test says.
function oddUser(id) {
  const label = `user(${String(id).slice(0, 12)})`;
  return session.strict(label, {
    id, username: 'odd_user', globalName: null, discriminator: '0', bot: false, system: false, partial: false, avatar: null,
    tag: 'odd_user', displayName: 'odd_user', createdTimestamp: 0, createdAt: new Date(0),
    toString() { return `<@${id}>`; },
    displayAvatarURL() { return 'https://cdn.discordapp.com/embed/avatars/0.png'; },
    avatarURL() { return null; },
  });
}

// ---------------------------------------------------------------------------------------------------------
// IDs that are not snowflakes
// ---------------------------------------------------------------------------------------------------------

const SNOWFLAKE_VARIANTS = Object.freeze([
  ['16 digits', '7600000000000003'],
  ['21 digits', '760000000000000003999'],
  ['25 digits', '7600000000000000030000000'],
  ['spaces around it', ' 760000000000000003 '],
  ['a minus sign', '-760000000000000003'],
  ['a plus sign', '+760000000000000003'],
  ['leading zeros', '0000760000000000000003'],
  ['a mention', '<@760000000000000003>'],
  ['a nickname mention', '<@!760000000000000003>'],
  ['a role mention', '<@&763000000000000001>'],
  ['hexadecimal', '0x2a4e3a3cc8000003'],
  ['an exponent', '7.60000000000000003e17'],
  ['a fraction', '760000000000000003.5'],
  ['full-width digits', '\u{ff17}\u{ff16}\u{ff10}\u{ff10}\u{ff10}\u{ff10}\u{ff10}\u{ff10}\u{ff10}\u{ff10}\u{ff10}\u{ff10}\u{ff10}\u{ff10}\u{ff10}\u{ff10}\u{ff13}'],
  ['Arabic-Indic digits', '\u{667}\u{666}\u{660}\u{660}\u{660}\u{660}\u{660}\u{660}\u{660}\u{660}\u{660}\u{660}\u{660}\u{660}\u{660}\u{660}\u{663}'],
  ['a null byte', '760000000000000003\u{0}'],
  ['a line break and a second ID', '760000000000000003\n760000000000000002'],
  ['a comma list', '760000000000000003,760000000000000002'],
  ['a SQL fragment', "760000000000000003' OR '1'='1"],
  ['a prototype name', '__proto__'],
  ['an empty text', ''],
  ['a very long number', '7'.repeat(5_000)],
]);

// The commands that take a user. `owner` says the path is the bot owner's; the others are run by the member (or by an
// Administrator where the catalog says so).
function userOptionPaths() {
  const listed = [];
  for (const entry of COMMAND_CATALOG) {
    for (const subcommand of entry.subcommands.length ? entry.subcommands : [null]) {
      const key = subcommand ? `${entry.name} ${subcommand}` : entry.name;
      let command = null;
      try { command = session.pathEntry(key); } catch { /* a command the catalog lists and the runtime does not */ }
      if (!command) continue;
      const option = command.options.find((candidate) => candidate.type === ApplicationCommandOptionType.User);
      if (!option) continue;
      const audience = subcommand ? getSubcommandAudience(entry, subcommand) : entry.audience;
      listed.push({ key, option: option.name, audience });
    }
  }
  return listed;
}

test('every command that takes a user is covered by the snowflake attacks', () => {
  const keys = userOptionPaths().map((entry) => entry.key);
  for (const required of ['bank balance-user', 'work status-user', 'shop purchases-user', 'economy user', 'coin-admin remove',
    'work task-add']) {
    assert.ok(keys.includes(required), `/${required} takes a user`);
  }
  assert.ok(keys.length >= 15, `${keys.length} paths take a user`);
});

function actorFor(audience) {
  // Every owner command is run by the bot owner and every other command by an Administrator, so the permission check
  // passes and it is the value that is refused.
  return audience === 'owner' ? 'owner' : audience === 'admin' ? 'admin' : 'member';
}

test('a user option that Discord did not resolve to a user is answered and writes nothing, whatever it says', async () => {
  const before = await wallets();
  let runs = 0;
  const problems = [];
  for (const { key, option, audience } of userOptionPaths()) {
    // Nothing was resolved, so what the text says is not looked at again; a few of each kind are enough here.
    for (const [name, value] of SNOWFLAKE_VARIANTS.filter((_, index) => index % 3 === 0 || index === 7)) {
      const outcome = await session.run(key, { as: actorFor(audience), options: { [option]: attack.raw({ value }) } });
      const label = `/${key} ${option}=${name}, unresolved`;
      attack.assertRanCleanly(outcome, label);
      assert.ok(outcome.texts.length >= 1, `${label}: the user is answered`);
      const written = session.changesBeyondTheCount(outcome);
      if (written.length) problems.push(`${label}: wrote ${written.join(', ')}`);
      runs += 1;
    }
  }
  assert.ok(runs >= 100, `${runs} runs`);
  assert.deepEqual(problems, [], 'an unresolved user wrote nothing');
  assert.deepEqual(await wallets(), before, 'no wallet moved and none was made');
});

// The wallets whose user is not a Discord snowflake (17 to 20 digits).
async function malformedWalletOwners() {
  const rows = await withCoinDatabase((api) => api.all('SELECT user_id FROM coin_wallets ORDER BY user_id'));
  return rows.map((row) => row.user_id).filter((id) => !/^\d{17,20}$/u.test(id));
}

const malformedFindings = { runs: 0, kept: [] };

test('a resolved user with a malformed ID is answered, and no other account is touched', async () => {
  const realBefore = await wallets();
  const knownBefore = new Set(await malformedWalletOwners());
  for (const { key, option, audience } of userOptionPaths()) {
    for (const [name, value] of SNOWFLAKE_VARIANTS) {
      const outcome = await session.run(key, {
        as: actorFor(audience), options: { [option]: attack.raw({ value, user: oddUser(value), member: null }) },
      });
      const label = `/${key} ${option}=${name}, resolved to a user with that ID`;
      attack.assertRanCleanly(outcome, label);
      assert.ok(outcome.texts.length >= 1, `${label}: the user is answered`);
      malformedFindings.runs += 1;
      // Normalized to a real ID (spaces and control characters cut off) is a write for that user; anything else
      // that was written under a name that is not a snowflake is kept for the report below.
      for (const id of await malformedWalletOwners()) {
        if (!knownBefore.has(id)) {
          knownBefore.add(id);
          malformedFindings.kept.push(`${label}: a wallet for ${JSON.stringify(id.slice(0, 40))}`);
        }
      }
    }
  }
  assert.ok(malformedFindings.runs >= 300, `${malformedFindings.runs} runs`);
  // Nobody else's wallet was touched: the real accounts that were there are as they were, except the ones a
  // normalized ID can legitimately name.
  const realAfter = await wallets();
  const untouched = realBefore.filter((row) => row.user_id !== IDS.target && row.user_id !== IDS.member);
  for (const row of untouched) assert.deepEqual(realAfter.find((after) => after.user_id === row.user_id), row);
});

test('the owner commands refuse a user ID that is not a snowflake instead of making an account for it', {
  todo: 'coin-admin add/remove/set/reset-user and the services behind them (coinService.adjustPlayerBalance, resetPlayerData, coinAdminAddService.createAddConfirmation) take any text as a user ID: 16, 21 and 25 digits, a mention, a sign, a SQL fragment or __proto__ each get a wallet or a stored preview; Discord only ever sends real IDs, so this is reached only by a caller that does not come from a slash command',
}, () => {
  assert.deepEqual(malformedFindings.kept, []);
});

// ---------------------------------------------------------------------------------------------------------
// IDs typed as text: item-id
// ---------------------------------------------------------------------------------------------------------

test('an item-id that is not an item ID is refused by every command that takes one, and nothing is bought, pawned or changed', async () => {
  const before = await ledgerTotals();
  const itemPaths = [
    ['shop buy', {}, 'member'], ['luxury buy', {}, 'member'], ['pawn quote', {}, 'member'], ['pawn sell', {}, 'member'],
  ];
  const values = [
    ['an empty text', ''], ['a short text', 'abc'], ['38 spaces', ' '.repeat(38)], ['38 zeros', '0'.repeat(38)],
    ['a prototype name', '__proto__'.padEnd(38, '_')], ['a SQL fragment', `' OR 1=1 --${'x'.repeat(27)}`.slice(0, 38)],
    ['a 5000-character text', 'g_'.repeat(2_500)], ['a null byte', `g_${'\u{0}'.repeat(36)}`], ['a mention', `<@${'7'.repeat(17)}>`.padEnd(38, '0')],
    ['a well-formed ID of nothing', `g_${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}`],
  ];
  let refusals = 0;
  for (const [key, extra, as] of itemPaths) {
    for (const [name, value] of values) {
      const outcome = await session.run(key, { as, options: { 'item-id': value, ...extra } });
      const label = `/${key} item-id=${name}`;
      attack.assertRanCleanly(outcome, label);
      assert.equal(outcome.texts.length, 1, `${label}: one answer`);
      assert.notEqual(outcome.last, FALLBACK, `${label}: a missing item is not a generic failure`);
      assert.deepEqual(session.changesBeyondTheCount(outcome), [], `${label}: nothing was written`);
      refusals += 1;
    }
  }
  assert.ok(refusals >= itemPaths.length * values.length, `${refusals} refusals`);
  assert.deepEqual(await ledgerTotals(), before, 'every ledger is as it was');
});

// ---------------------------------------------------------------------------------------------------------
// numbers outside what an option declares
// ---------------------------------------------------------------------------------------------------------

const HOSTILE_NUMBERS = Object.freeze([
  ['negative one', -1], ['minus nine billion', -9_000_000_000], ['zero', 0], ['negative zero', -0], ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY], ['a fraction', 1.5], ['one above 9e9', 9_000_000_001],
  ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER], ['1e21', 1e21], ['negative 1e21', -1e21],
]);

const NUMBER_COMMANDS = Object.freeze(['exchange', 'bank', 'casino', 'work', 'casino-venue']);

// Every numeric option of the five commands, with the paths' own actor.
function numericOptions() {
  const found = [];
  for (const name of NUMBER_COMMANDS) {
    const catalog = COMMAND_CATALOG.find((entry) => entry.name === name);
    for (const subcommand of catalog.subcommands) {
      const key = `${name} ${subcommand}`;
      const entry = session.pathEntry(key);
      const audience = getSubcommandAudience(catalog, subcommand);
      for (const option of entry.options) {
        if (![ApplicationCommandOptionType.Integer, ApplicationCommandOptionType.Number].includes(option.type)) continue;
        found.push({ key, option, audience });
      }
    }
  }
  return found;
}

// A value Discord's client would not have let through: outside the declared range, or not whole where whole is declared.
function isOutOfRange(option, value) {
  if (Number.isNaN(value) || !Number.isFinite(value)) return true;
  if (option.type === ApplicationCommandOptionType.Integer && !Number.isInteger(value)) return true;
  if (typeof option.min_value === 'number' && value < option.min_value) return true;
  if (typeof option.max_value === 'number' && value > option.max_value) return true;
  return false;
}

test('every numeric option of /exchange, /bank, /casino, /work and /casino-venue is covered', () => {
  const found = numericOptions();
  const keys = new Set(found.map((entry) => entry.key));
  for (const required of ['exchange buy-chips', 'exchange cashout', 'bank deposit', 'bank withdraw', 'bank fixed-create',
    'bank fixed-claim', 'casino loan-borrow', 'casino loan-repay', 'work start', 'work submissions', 'casino-venue order',
    'casino-venue make', 'casino-venue serve']) {
    assert.ok(keys.has(required), `/${required} has a numeric option`);
  }
  assert.ok(found.length >= 30, `${found.length} numeric options`);
});

// Values a service reads in a more forgiving way than the option declares, with the reason. Each is still checked: it
// must apply exactly what it reads, which the services' own tests hold it to (test/securityAttackEconomyInputs.test.js).
const FORGIVEN = Object.freeze({
  'work start days': Object.freeze({ 1.5: 'a number of days is whole; a fraction is rounded down to the day' }),
});

const numberFindings = { generic: [] };

test('a number outside what an option declares is refused by the handler, whoever sends it, and nothing moves', async () => {
  const before = await ledgerTotals();
  let runs = 0;
  const problems = [];
  const generic = numberFindings.generic;
  for (const { key, option, audience } of numericOptions()) {
    const as = audience === 'owner' ? 'owner' : audience === 'admin' ? 'admin' : 'member';
    // The largest whole number JavaScript keeps exactly is outside every declared range that has an upper bound, and
    // a number nobody can pay or name for the ones that do not (an ID, an amount of the wallet).
    for (const [name, value] of HOSTILE_NUMBERS) {
      if (!isOutOfRange(option, value) && value !== Number.MAX_SAFE_INTEGER) continue;
      const outcome = await session.run(key, { as, options: { [option.name]: value } });
      const label = `/${key} ${option.name}=${name}`;
      attack.assertRanCleanly(outcome, label);
      assert.ok(outcome.texts.length >= 1, `${label}: the user is answered`);
      runs += 1;
      if (FORGIVEN[`${key} ${option.name}`]?.[value]) continue;
      const written = session.changesBeyondTheCount(outcome);
      if (written.length) problems.push(`${label}: wrote ${written.join(', ')}`);
      if (outcome.last === FALLBACK) generic.push(label);
    }
  }
  assert.ok(runs >= 250, `${runs} runs`);
  assert.deepEqual(problems, [], 'a number outside its range wrote nothing');
  const totals = await ledgerTotals();
  assert.deepEqual(totals.wallets, before.wallets, 'no wallet moved');
  assert.deepEqual(totals.chips, before.chips, 'no chip account moved');
  assert.deepEqual(totals.bank, before.bank, 'no bank account moved');
});

test('a refused number is told to the user as a refusal and not as a failure of the system', {
  todo: '/bank balance-all, /bank fixed-all and /bank rate-history take limit=1.5 as it is (the limit is not made a whole number), and the query fails with the generic "system cannot handle" answer and an error log; Discord only sends whole numbers for an integer option',
}, () => {
  assert.deepEqual(numberFindings.generic, []);
});

test('numbers inside the range still work, so the refusals above are not a command that refuses everything', async () => {
  const deposit = await session.run('bank deposit', { as: 'member', options: { amount: 100 } });
  attack.assertRanCleanly(deposit, 'bank deposit 100');
  assert.ok(Object.hasOwn(deposit.changes.tables, 'coin_wallets'), 'a deposit is written');
  const buy = await session.run('exchange buy-chips', { as: 'member', options: { amount: 100 } });
  attack.assertRanCleanly(buy, 'exchange buy-chips 100');
  assert.ok(Object.hasOwn(buy.changes.tables, 'chip_ledger'));
  const limit = await session.run('bank balance-all', { as: 'admin', options: { limit: 25 } });
  attack.assertRanCleanly(limit, 'bank balance-all 25');
});

// ---------------------------------------------------------------------------------------------------------
// text no one asked for
// ---------------------------------------------------------------------------------------------------------

const STRANGE_TEXTS = Object.freeze([
  ['an empty text', () => ''], ['spaces only', () => '   '], ['a null byte', () => '\u{0}'],
  ['a prototype name', () => '__proto__'], ['a SQL fragment', () => "'; DROP TABLE coin_wallets; --"],
  ['a template', () => '${process.exit(1)}{{7*7}}'], ['a lone surrogate', () => '\u{d800}'],
  ['control characters', () => '\u{1}\u{2}\u{1b}[2J\u{7f}'], ['a bidirectional override', () => '\u{202e}abc'],
  ['just over its limit', (option) => 'a'.repeat((option.max_length || 100) + 1)],
  ['a million characters', () => 'a'.repeat(1_000_000)],
]);

function stringOptions() {
  const found = [];
  for (const name of NUMBER_COMMANDS) {
    const catalog = COMMAND_CATALOG.find((entry) => entry.name === name);
    for (const subcommand of catalog.subcommands) {
      const key = `${name} ${subcommand}`;
      const entry = session.pathEntry(key);
      const audience = getSubcommandAudience(catalog, subcommand);
      for (const option of entry.options) {
        if (option.type === ApplicationCommandOptionType.String) found.push({ key, option, audience });
      }
    }
  }
  return found;
}

const choiceFindings = { kept: [] };

test('text of any shape given to a string option of the five commands is answered, and no table or balance is damaged', async () => {
  // The first look at a guild's venue menu stocks the default menu; that write is not what is being attacked here.
  await session.run('casino-venue menu', { as: 'member' });
  const tablesBefore = await withCoinDatabase((api) => api.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"));
  const options = stringOptions();
  assert.ok(options.length >= 12, `${options.length} string options`);
  let runs = 0;
  const problems = [];
  for (const { key, option, audience } of options) {
    const as = audience === 'owner' ? 'owner' : audience === 'admin' ? 'admin' : 'member';
    for (const [name, make] of STRANGE_TEXTS) {
      const outcome = await session.run(key, { as, options: { [option.name]: make(option) } });
      const label = `/${key} ${option.name}=${name}`;
      attack.assertRanCleanly(outcome, label);
      assert.ok(outcome.texts.length >= 1, `${label}: the user is answered`);
      assert.equal(outcome.changes.schemaChanged, false, `${label}: the schema is as it was`);
      // An option with a fixed set of choices takes nothing else.
      if (Array.isArray(option.choices) && option.choices.length) {
        const written = session.changesBeyondTheCount(outcome);
        if (written.length) {
          const entry = `${label}: wrote ${written.join(', ')}`;
          // /bank fixed-create reads a source that is not "bank" as the wallet (the todo below).
          if (key === 'bank fixed-create' && option.name === 'source') choiceFindings.kept.push(entry);
          else problems.push(entry);
        }
      }
      runs += 1;
    }
  }
  assert.ok(runs >= 100, `${runs} runs`);
  assert.deepEqual(problems, [], 'a value that is not one of the choices wrote nothing');
  const tablesAfter = await withCoinDatabase((api) => api.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"));
  assert.deepEqual(tablesAfter, tablesBefore, 'no table was dropped or made');
  // Every wallet still equals the sum of its own transactions.
  const totals = await ledgerTotals();
  const sums = new Map(totals.transactions.map((row) => [row.user_id, Number(row.total)]));
  for (const wallet of totals.wallets) {
    assert.ok(Number.isSafeInteger(wallet.balance) && wallet.balance >= 0, `${wallet.user_id} holds a sound balance`);
    assert.equal(wallet.balance, sums.get(wallet.user_id) || 0, `${wallet.user_id} equals the sum of their transactions`);
  }
});

test('a source that is neither the wallet nor the bank is refused by /bank fixed-create instead of read as the wallet', {
  todo: '/bank fixed-create reads any source value other than "bank" as the wallet and makes the deposit from it (an empty text, a typo or "Bank" included), so a hand-made request that mistypes the source spends the wallet instead of being refused; Discord only offers the two choices',
}, () => {
  assert.deepEqual(choiceFindings.kept, []);
});
