'use strict';

// /leaderboard against a real, isolated coin database. Only Discord is faked: the settings, the
// ordering and the paging come from the real services, so these tests show what a guild really sees.
// The fake interaction answers by discord.js's rules and logs every call, so the tests also show when
// the command acknowledged itself, which matters because Discord gives a command only three seconds.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-leaderboard-'));
process.env.COIN_DB_PATH = path.join(root, 'leaderboard.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';

const leaderboardCommand = require('../src/commands/leaderboard');
const { CoinDatabaseError, initializeNewCoinDatabase, resetCoinDatabaseForTests } = require('../src/services/coinDatabase');
const { adjustPlayerBalance, setGuildEconomyEnabled } = require('../src/services/coinService');

const GUILD_ID = 'leaderboard-guild';
const EMPTY_GUILD_ID = 'leaderboard-guild-without-players';
const PLAYER_COUNT = 25;
const OPERATOR_ID = 'fixture-admin';
const BOT_IDS = ['user-03', 'user-12'];
const NO_PINGS = { parse: [] };
const DISABLED_TEXT = '這個伺服器的吉幣系統目前停用。';
const FALLBACK_ERROR_TEXT = '系統暫時無法處理吉幣資料，請稍後再試。';
// The calls that answer the user; a deferral only acknowledges the command and a lookup is not an answer.
const ANSWERS = new Set(['reply', 'editReply', 'followUp']);

// user-01 has the most coins and user-25 the fewest, so a user's number is its true rank.
const userIdOf = (rank) => `user-${String(rank).padStart(2, '0')}`;
const balanceOf = (rank) => 10000 - rank * 10;
const coinsText = (amount) => `${amount.toLocaleString('zh-TW')} 吉幣`;
const rankOf = (line) => Number(/^(\d+)\. /u.exec(line)[1]);
const boardLines = (payload) => payload.content.split('\n').slice(1);
// The interaction calls only, in order, without the user lookups.
const interactionCalls = (calls) => calls.filter(({ name }) => name !== 'fetch').map(({ name }) => name);

// The assets board exactly as it was sent before the command acknowledged itself first: the 25 people in
// order, the two bots left out as gaps in the ranks, and nobody pinged.
function expectedAssetsBoard() {
  const lines = Array.from({ length: PLAYER_COUNT }, (_, index) => index + 1)
    .filter((rank) => !BOT_IDS.includes(userIdOf(rank)))
    .map((rank) => `${rank}. <@${userIdOf(rank)}> - ${coinsText(balanceOf(rank))}`);
  return { content: ['**Fixture Guild 總資產排行榜**', ...lines].join('\n'), allowedMentions: NO_PINGS };
}

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  for (let rank = 1; rank <= PLAYER_COUNT; rank += 1) {
    await adjustPlayerBalance(GUILD_ID, userIdOf(rank), {
      action: 'add', amount: balanceOf(rank), operatorId: OPERATOR_ID, reason: 'leaderboard fixture',
    });
  }
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

// Runs the command against the fake interaction and returns the one answer it gave (a reply, or the edit
// of a deferred reply), the user lookups, and `calls`: every interaction call and every lookup in the order
// they happened. Like discord.js, the first response is a reply or a deferral and happens only once, and an
// edit or follow-up needs one before it. A lookup is never cached and really waits, as a cold cache does.
// failFirstEdit makes Discord refuse the first editReply, which discord.js reports without marking the
// command as replied.
async function runBoard({
  guildId = GUILD_ID, type, page, botIds = BOT_IDS, command = leaderboardCommand, failFirstEdit = false,
} = {}) {
  const calls = [];
  const lookedUp = [];
  const interaction = {
    commandName: 'leaderboard',
    guildId,
    guild: { name: 'Fixture Guild' },
    replied: false,
    deferred: false,
    inGuild: () => true,
    client: {
      users: {
        fetch: async (id) => {
          lookedUp.push(id);
          calls.push({ name: 'fetch', id });
          await new Promise((resolve) => setImmediate(resolve));
          return { id, bot: botIds.includes(id), toString: () => `<@${id}>` };
        },
      },
    },
    options: {
      getString: (key) => (key === 'type' ? type ?? null : null),
      getInteger: (key) => (key === 'page' ? page ?? null : null),
    },
    async reply(payload) {
      if (interaction.deferred || interaction.replied) throw new Error('InteractionAlreadyReplied');
      calls.push({ name: 'reply', payload });
      interaction.replied = true;
    },
    async deferReply(options) {
      if (interaction.deferred || interaction.replied) throw new Error('InteractionAlreadyReplied');
      calls.push({ name: 'deferReply', options });
      interaction.deferred = true;
    },
    async editReply(payload) {
      if (!interaction.deferred && !interaction.replied) throw new Error('InteractionNotReplied');
      const refused = failFirstEdit && calls.every(({ name }) => name !== 'editReply');
      calls.push({ name: 'editReply', payload, refused });
      if (refused) throw new Error('Discord refused the edit');
      interaction.replied = true;
    },
    async followUp(payload) {
      if (!interaction.deferred && !interaction.replied) throw new Error('InteractionNotReplied');
      calls.push({ name: 'followUp', payload });
      interaction.replied = true;
    },
  };
  await command.execute(interaction);
  const answers = calls.filter(({ name, refused }) => ANSWERS.has(name) && !refused);
  assert.equal(answers.length, 1, 'the command answers exactly once');
  return { reply: answers[0].payload, lookedUp, calls };
}

// The command takes the service functions when it is loaded, so a copy of it whose board query fails is a
// fresh load while the service is patched. The service and the module cache are put back right after.
function loadCommandWithFailingBoardQuery(error) {
  const commandPath = require.resolve('../src/commands/leaderboard');
  const service = require('../src/services/bankService');
  const originalQuery = service.getAllBalanceSummaries;
  const originalEntry = require.cache[commandPath];
  service.getAllBalanceSummaries = async () => { throw error; };
  delete require.cache[commandPath];
  try {
    return require(commandPath);
  } finally {
    service.getAllBalanceSummaries = originalQuery;
    require.cache[commandPath] = originalEntry;
  }
}

test('the coin board pages ten rows at a time and every rank is the row\'s real place', async () => {
  const shown = [];
  for (const [page, expected] of [
    [1, [1, 2, 4, 5, 6, 7, 8, 9, 10]],
    [2, [11, 13, 14, 15, 16, 17, 18, 19, 20]],
    [3, [21, 22, 23, 24, 25]],
  ]) {
    const { reply, calls } = await runBoard({ page });
    assert.deepEqual(interactionCalls(calls), ['reply'], `page ${page} is one plain reply, never deferred`);
    assert.equal(reply.ephemeral, undefined, `page ${page} is public`);
    assert.deepEqual(reply.allowedMentions, NO_PINGS, `page ${page} cannot ping`);
    const lines = boardLines(reply);
    assert.deepEqual(lines.map(rankOf), expected, `page ${page}`);
    for (const line of lines) {
      const rank = rankOf(line);
      assert.ok(line.startsWith(`${rank}. <@${userIdOf(rank)}> - ${coinsText(balanceOf(rank))}（連續 `), `page ${page}: ${line}`);
    }
    shown.push(...lines.map(rankOf));
  }
  // Every person appears on exactly one page and nobody is skipped; the two bots leave only gaps.
  assert.deepEqual(shown, Array.from({ length: PLAYER_COUNT }, (_, index) => index + 1).filter((rank) => rank !== 3 && rank !== 12));

  const { reply } = await runBoard({ page: 4 });
  assert.deepEqual(reply, { content: '目前還沒有吉幣排行榜資料。', ephemeral: true, allowedMentions: NO_PINGS });
});

test('the board without a type is the coin board, and the coin board looks up only ten users a page', async () => {
  const implicit = await runBoard();
  const explicit = await runBoard({ type: 'coins' });
  assert.deepEqual(implicit.reply, explicit.reply);
  assert.deepEqual(implicit.lookedUp, Array.from({ length: 10 }, (_, index) => userIdOf(index + 1)));
  assert.deepEqual(interactionCalls(implicit.calls), ['reply'], 'the coin board is still one plain reply');
});

test('the assets board lists the top 25 people, leaves bots out and cannot ping', async () => {
  const { reply, lookedUp } = await runBoard({ type: 'assets', page: 2 });
  assert.equal(reply.ephemeral, undefined, 'the assets board is public');
  assert.deepEqual(reply.allowedMentions, NO_PINGS);
  assert.equal(lookedUp.length, PLAYER_COUNT);
  const lines = boardLines(reply);
  assert.deepEqual(lines.map(rankOf), Array.from({ length: PLAYER_COUNT }, (_, index) => index + 1).filter((rank) => rank !== 3 && rank !== 12));
  for (const line of lines) {
    const rank = rankOf(line);
    assert.equal(line, `${rank}. <@${userIdOf(rank)}> - ${coinsText(balanceOf(rank))}`);
  }
  assert.equal(reply.content.includes(userIdOf(3)), false);
  assert.equal(reply.content.includes(userIdOf(12)), false);
});

test('a guild with the coin system off gets neither board, and both boards say so the same way', async () => {
  await setGuildEconomyEnabled(GUILD_ID, false, { operatorId: OPERATOR_ID });
  try {
    const coins = await runBoard({ type: 'coins' });
    const assets = await runBoard({ type: 'assets' });
    assert.deepEqual(coins.reply, { content: '這個伺服器的吉幣系統目前停用。', ephemeral: true });
    assert.deepEqual(assets.reply, coins.reply, 'the assets board refuses exactly as the coin board does');
    assert.deepEqual(assets.lookedUp, [], 'no user was looked up for a board that is not shown');
    assert.equal(assets.reply.content.includes('<@'), false);
  } finally {
    await setGuildEconomyEnabled(GUILD_ID, true, { operatorId: OPERATOR_ID });
  }
  assert.match((await runBoard({ type: 'assets' })).reply.content, /總資產排行榜/u);
});

test('a guild with no players keeps the visibility each board always had', async () => {
  const coins = await runBoard({ guildId: EMPTY_GUILD_ID, type: 'coins' });
  assert.deepEqual(coins.reply, { content: '目前還沒有吉幣排行榜資料。', ephemeral: true, allowedMentions: NO_PINGS });
  assert.deepEqual(interactionCalls(coins.calls), ['reply']);
  const assets = await runBoard({ guildId: EMPTY_GUILD_ID, type: 'assets' });
  // The notice stays public: the acknowledgement was public, and an edit cannot make it private.
  assert.deepEqual(assets.reply, { content: '目前沒有經濟資料。', allowedMentions: NO_PINGS });
  assert.deepEqual(interactionCalls(assets.calls), ['deferReply', 'editReply']);
});

test('a guild with the coin system off is refused with one private reply and the assets board never defers', async () => {
  await setGuildEconomyEnabled(GUILD_ID, false, { operatorId: OPERATOR_ID });
  try {
    const { calls } = await runBoard({ type: 'assets' });
    // The whole log is that one reply: no deferral, no user lookup and no edit.
    assert.deepEqual(calls, [{ name: 'reply', payload: { content: DISABLED_TEXT, ephemeral: true } }]);
  } finally {
    await setGuildEconomyEnabled(GUILD_ID, true, { operatorId: OPERATOR_ID });
  }
});

test('the assets board acknowledges publicly first and then edits in exactly the board it used to reply with', async () => {
  const { reply, calls } = await runBoard({ type: 'assets' });
  assert.deepEqual(interactionCalls(calls), ['deferReply', 'editReply']);
  const { options } = calls.find(({ name }) => name === 'deferReply');
  assert.ok(!options?.ephemeral && !options?.flags, 'the acknowledgement is public, like the board');
  assert.deepEqual(reply, expectedAssetsBoard());
});

test('with a cold cache the assets board is acknowledged before its first of 25 lookups and answered after the last', async () => {
  const { calls, lookedUp } = await runBoard({ type: 'assets' });
  assert.equal(lookedUp.length, PLAYER_COUNT, 'every one of the 25 rows is a lookup');
  const names = calls.map(({ name }) => name);
  assert.equal(names[0], 'deferReply', 'nothing is looked up before the command is acknowledged');
  assert.deepEqual(names.slice(1, -1), Array(PLAYER_COUNT).fill('fetch'));
  assert.equal(names.at(-1), 'editReply', 'the board is sent only once every lookup is done');
});

test('an error after the assets board was acknowledged is shown by editing that reply', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const failing = loadCommandWithFailingBoardQuery(new CoinDatabaseError('SQLITE_BUSY: database is locked'));

  // execute() resolves: a rejection here would be an unhandled error and fail this test.
  const { reply, calls, lookedUp } = await runBoard({ type: 'assets', command: failing });

  assert.deepEqual(interactionCalls(calls), ['deferReply', 'editReply'], 'the error is an edit, never a second reply');
  assert.equal(reply, FALLBACK_ERROR_TEXT);
  assert.equal(String(reply).includes('SQLITE'), false, 'the internal reason stays in the console');
  assert.deepEqual(lookedUp, [], 'the query failed before any user was looked up');
  assert.ok(logged.mock.calls.some(({ arguments: [message] }) => String(message).includes('/leaderboard')), 'the failure is logged');
});

test('when sending the board itself fails, the failure is shown by editing again and never by replying', async (t) => {
  t.mock.method(console, 'error', () => {});

  const { reply, calls } = await runBoard({ type: 'assets', failFirstEdit: true });

  assert.deepEqual(interactionCalls(calls), ['deferReply', 'editReply', 'editReply']);
  const edits = calls.filter(({ name }) => name === 'editReply');
  assert.equal(edits[0].refused, true, 'the first edit, the board, was the one Discord refused');
  assert.equal(edits[0].payload.content.includes('總資產排行榜'), true);
  assert.equal(reply, FALLBACK_ERROR_TEXT);
});
