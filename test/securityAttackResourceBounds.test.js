'use strict';

// Measurements, not fixes: what the bot keeps in memory or on disk that has no upper bound, and what one write of the
// coin database costs as the database grows.
//
// A test that passes pins a number or a rule that held. A test marked todo is a limit that is reported and not fixed
// here: it asserts the bound the code does not have yet, so it starts to pass when the bound is added. The numbers a
// run measured are written with t.diagnostic and appear in the test output.
//
// Nothing here uses the network, Discord or a real database: the services run against a synthetic SQLite file and a
// synthetic JSON store inside the temporary directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const harness = require('./support/securityAttackHarness');

const root = harness.createAttackEnvironment('xiaoji-attack-resources-');

const coin = require('../src/services/coinService');
const venueService = require('../src/services/venueService');
const { withCoinTransaction } = require('../src/services/coinDatabase');
const { retainedDataFile } = require('../src/platform/retainedDataSource');

const GUILD = '860000000000000001';
const OPERATOR = '860000000000000099';
const USER = '860000000000000011';

const previousOwner = process.env.BOT_OWNER_ID;
process.env.BOT_OWNER_ID = OPERATOR;

test.after(() => {
  if (previousOwner === undefined) delete process.env.BOT_OWNER_ID;
  else process.env.BOT_OWNER_ID = previousOwner;
  harness.closeAttackDatabase(root);
});

// ---------------------------------------------------------------------------------------------------------
// the conversation state: three maps that are never swept
// ---------------------------------------------------------------------------------------------------------

// Loads the conversation service afresh with every Map it makes while loading recorded, so the sizes of its private
// maps can be read exactly. (Nothing else of the process uses this copy.)
function loadConversationService() {
  const RealMap = global.Map;
  const created = [];
  class RecordingMap extends RealMap {
    constructor(...args) {
      super(...args);
      created.push(this);
    }
  }
  const modulePath = require.resolve('../src/services/conversationModeService');
  const previous = require.cache[modulePath];
  global.Map = RecordingMap;
  try {
    delete require.cache[modulePath];
    const service = require(modulePath);
    return { service, created, restore() { if (previous) require.cache[modulePath] = previous; else delete require.cache[modulePath]; } };
  } finally {
    global.Map = RealMap;
  }
}

const message = (index) => ({ guildId: `g${index % 97}`, channelId: `c${index % 1013}`, author: { id: `u${index}` } });

// Which of the recorded maps is which: each is found by the one call that fills it.
function findMaps({ service, created }) {
  const probe = { guildId: 'probe-guild', channelId: 'probe-channel', author: { id: 'probe-user' } };
  const sizes = () => created.map((map) => map.size);
  const grew = (before, after) => created.filter((_, position) => after[position] === before[position] + 1);
  let before = sizes();
  service.startConversation(probe, 0);
  const active = grew(before, sizes())[0];
  service.endConversation(probe);
  before = sizes();
  service.checkCooldown(probe, 0);
  const cooldowns = grew(before, sizes())[0];
  before = sizes();
  service.silenceConversation(probe, 0);
  const silence = grew(before, sizes())[0];
  for (const map of [active, cooldowns, silence]) map.clear();
  assert.ok(active && cooldowns && silence && new Set([active, cooldowns, silence]).size === 3, 'the three maps were found');
  return { active, cooldowns, silence };
}

const conversationFindings = {};

test('the conversation maps hold one entry for each (guild, channel, user) and are not swept when the entries expire', (t) => {
  const loaded = loadConversationService();
  t.after(() => loaded.restore());
  const { service } = loaded;
  const maps = findMaps(loaded);
  const COUNT = 20_000;
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  for (let index = 0; index < COUNT; index += 1) {
    service.startConversation(message(index), 0);
    service.checkCooldown(message(COUNT + index), 0);
    service.silenceConversation(message(2 * COUNT + index), 0);
  }
  const filled = { active: maps.active.size, cooldowns: maps.cooldowns.size, silence: maps.silence.size };
  assert.deepEqual(filled, { active: COUNT, cooldowns: COUNT, silence: COUNT }, 'one entry for each member');

  // A week later every entry has expired (four minutes, three seconds and a minute). The service looks at one entry
  // only when that member writes again; the others stay where they are.
  for (let index = 0; index < 50; index += 1) {
    service.getActiveConversation?.(message(index), WEEK);
    service.hasActiveConversation(message(index), WEEK);
    service.isConversationSilenced(message(2 * COUNT + index), WEEK);
    service.checkCooldown(message(COUNT + index), WEEK);
  }
  // A new message from a member nobody has seen before does not sweep the others either.
  service.checkCooldown(message(9 * COUNT), WEEK);
  conversationFindings.afterWeek = { active: maps.active.size, cooldowns: maps.cooldowns.size, silence: maps.silence.size };
  conversationFindings.count = COUNT;
  t.diagnostic(`after ${COUNT} members each in three maps, and a week: ${JSON.stringify(conversationFindings.afterWeek)}`);
  // What is true today, pinned: expired entries that nobody looks at again remain.
  assert.ok(maps.cooldowns.size > COUNT, 'a cooldown entry is only ever set; nothing deletes it');
});

test('the conversation maps drop entries that have expired', {
  todo: 'src/services/conversationModeService.js keeps activeConversations, cooldowns and silenceUntil in plain Maps with no size limit and no sweep: cooldowns is only ever set (never deleted), and an expired conversation or silence is removed only when the same member writes again, so every distinct (guild, channel, user) that ever mentioned the bot stays in memory until restart',
}, () => {
  const { count, afterWeek } = conversationFindings;
  assert.ok(afterWeek, 'the measurement ran');
  // A week later the three maps should hold next to nothing: at most the members touched since.
  assert.ok(afterWeek.cooldowns < count / 10, `cooldowns holds ${afterWeek.cooldowns} entries after a week`);
  assert.ok(afterWeek.active < count / 10, `activeConversations holds ${afterWeek.active} entries after a week`);
  assert.ok(afterWeek.silence < count / 10, `silenceUntil holds ${afterWeek.silence} entries after a week`);
});

// ---------------------------------------------------------------------------------------------------------
// a poll keeps every voter, and every vote rewrites the file
// ---------------------------------------------------------------------------------------------------------

const pollFindings = {};

test('observation: a poll stores one small entry per voter, and each vote rewrites the whole polls file', async (t) => {
  const pollService = require('../src/services/pollService');
  const pollsFile = retainedDataFile('polls.json');
  const channelId = '860000000000000500';
  let nextMessage = 0;
  const reply = (interaction) => async (options) => { interaction.replies.push(options); };
  const makeInteraction = (userId, customId = null, messageId = null) => {
    const interaction = {
      replies: [], id: `interaction-${userId}`, guildId: GUILD, channelId, user: { id: userId },
      client: { channels: { fetch: async () => ({ messages: { fetch: async () => ({ edit: async () => {} }) } }) } },
      customId, message: messageId ? { id: messageId } : null,
      deferred: false, replied: false,
    };
    interaction.deferReply = async () => { interaction.deferred = true; };
    interaction.editReply = async (options) => {
      interaction.replies.push(options);
      if (typeof options === 'string') { nextMessage += 1; return { id: `860000000000${String(nextMessage).padStart(6, '0')}` }; }
      return { id: 'edited' };
    };
    interaction.reply = reply(interaction);
    interaction.update = reply(interaction);
    return interaction;
  };

  // One poll, made through the real service (the creator's message ID is what the vote buttons carry).
  const creator = makeInteraction('860000000000000010');
  await pollService.createPoll(creator, { question: '投票容量測試？', options: ['甲', '乙'], durationMinutes: 60 });
  const pollMessage = Object.values(pollService.readPolls()).find((poll) => poll.question === '投票容量測試？').messageId;

  const VOTERS = 600;
  const sizes = [];
  const timings = [];
  for (let index = 0; index < VOTERS; index += 1) {
    const userId = `86000000000${String(100_000 + index)}`;
    const interaction = makeInteraction(userId, `poll:${pollMessage}:${index % 2}`, pollMessage);
    const started = performance.now();
    await pollService.handlePollButton(interaction);
    timings.push(performance.now() - started);
    assert.equal(interaction.replies.length, 1, 'every voter is answered once');
    if ((index + 1) % 200 === 0) sizes.push([index + 1, fs.statSync(pollsFile).size]);
  }
  const stored = pollService.readPolls()[pollMessage];
  assert.equal(Object.keys(stored.votes).length, VOTERS, 'every voter has a vote in the file');
  const mean = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
  const early = mean(timings.slice(0, 100));
  const late = mean(timings.slice(-100));
  pollFindings.voters = VOTERS;
  pollFindings.fileBytes = fs.statSync(pollsFile).size;
  t.diagnostic(`${VOTERS} voters: file ${pollFindings.fileBytes} bytes (${JSON.stringify(sizes)}); mean vote ${early.toFixed(2)} ms early, `
    + `${late.toFixed(2)} ms late (${(late / early).toFixed(1)}x)`);
  // Observation: the polls file is read, parsed, written to a temporary file, fsynced and renamed for every vote
  // (src/services/pollService.js savePoll), and no number caps the voters of a poll; the bound is the size of the
  // guild. One voter costs about 30 bytes of the file, so six hundred voters are 18 KB and the cost of a vote stays near
  // the cost of the fsync; this only becomes a problem for a guild of a hundred thousand members.
  assert.ok(Math.max(...timings) < 5_000, 'a vote does not hang');
  assert.ok(late / early < 5, `a vote late in a poll costs ${(late / early).toFixed(1)}x a vote early in it`);
  // A voter is a key of an object: a later vote of the same voter moves it and does not add one.
  const again = makeInteraction('86000000000100000', `poll:${pollMessage}:1`, pollMessage);
  await pollService.handlePollButton(again);
  assert.equal(Object.keys(pollService.readPolls()[pollMessage].votes).length, VOTERS);
});

// ---------------------------------------------------------------------------------------------------------
// the casino restaurant menu: any member may add items, with no cap
// ---------------------------------------------------------------------------------------------------------

test('a member can add menu items to a guild without a count or a rate limit', async (t) => {
  await harness.openAttackDatabase(root);
  await coin.setGuildEconomyEnabled(GUILD, true, { operatorId: OPERATOR });
  const ADDS = 300;
  const started = performance.now();
  let accepted = 0;
  for (let index = 0; index < ADDS; index += 1) {
    await venueService.addVenueMenuItem(GUILD, { itemType: 'meal', name: `容量測試餐點 ${index}`, steps: '煮;盛', createdBy: USER });
    accepted += 1;
  }
  const elapsed = performance.now() - started;
  const rows = await harness.readRows('SELECT COUNT(*) AS count FROM casino_venue_menu WHERE guild_id = ? AND created_by = ?', [GUILD, USER]);
  t.diagnostic(`${ADDS} menu items by one member in ${elapsed.toFixed(0)} ms (${(elapsed / ADDS).toFixed(1)} ms each)`);
  assert.equal(rows[0].count, accepted);
  assert.equal(accepted, ADDS);
  assert.ok(elapsed < 120_000, 'the adds finish');
});

test('a member is limited in how many menu items they add', {
  todo: 'src/services/venueService.js addVenueMenuItem inserts a row for every call from any member: there is no cap on items for a guild or for a member and no rate limit (/casino-venue add-menu is a public subcommand), and each insert rewrites the whole coin database file',
}, async () => {
  const rows = await harness.readRows('SELECT COUNT(*) AS count FROM casino_venue_menu WHERE guild_id = ? AND created_by = ?', [GUILD, USER]);
  assert.ok(rows[0].count <= 100, `${rows[0].count} items by one member in a guild`);
});

// ---------------------------------------------------------------------------------------------------------
// one transaction of the coin database is a full export and a file replace
// ---------------------------------------------------------------------------------------------------------

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function timeTransactions(count, userId) {
  const timings = [];
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    const at = performance.now();
    await coin.adjustPlayerBalance(GUILD, userId, {
      action: 'add', amount: 1, operatorId: OPERATOR, reason: 'resource bench', operationId: `bench-${userId}-${index}-${Math.random()}`,
    });
    timings.push(performance.now() - at);
  }
  const total = performance.now() - started;
  const sorted = [...timings].sort((left, right) => left - right);
  return {
    count, totalMs: total, meanMs: total / count, p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), maxMs: sorted.at(-1),
  };
}

async function growDatabase(rows) {
  await withCoinTransaction((api) => {
    const stamp = '2026-03-02T04:00:00.000Z';
    for (let index = 0; index < rows; index += 1) {
      api.run(
        `INSERT INTO coin_transactions (guild_id, user_id, type, balance_before, amount, balance_after, operator_id, reason,
           metadata, wallet_scope, wallet_revision, created_at)
         VALUES (?, ?, 'system_reward', 0, 1, 1, ?, ?, NULL, 'global', NULL, ?)`,
        [GUILD, `86000000010${String(index % 5_000).padStart(6, '0')}`, OPERATOR, `資料庫大小測試 ${index}`, stamp]
      );
    }
  });
}

function describe(label, result) {
  return `${label}: ${result.count} transactions in ${result.totalMs.toFixed(0)} ms, mean ${result.meanMs.toFixed(1)} ms, `
    + `p50 ${result.p50Ms.toFixed(1)} ms, p95 ${result.p95Ms.toFixed(1)} ms, max ${result.maxMs.toFixed(1)} ms`;
}

const benchFindings = {};

test('200 coin transactions on a small database, and on the same database after it has grown', async (t) => {
  await harness.openAttackDatabase(root);
  await coin.setGuildEconomyEnabled(GUILD, true, { operatorId: OPERATOR });
  const databasePath = require('../src/services/coinDatabase').getCoinDatabasePath();
  const small = await timeTransactions(200, USER);
  const smallBytes = fs.statSync(databasePath).size;
  t.diagnostic(`${describe('small database', small)}; file ${smallBytes} bytes`);

  await growDatabase(60_000);
  const grownBytes = fs.statSync(databasePath).size;
  const grown = await timeTransactions(200, USER);
  t.diagnostic(`${describe('grown database', grown)}; file ${grownBytes} bytes (${(grownBytes / smallBytes).toFixed(1)}x)`);
  t.diagnostic(`cost of one transaction grew ${(grown.meanMs / small.meanMs).toFixed(1)}x for a file ${(grownBytes / smallBytes).toFixed(1)}x larger`);

  benchFindings.smallMeanMs = small.meanMs;
  benchFindings.grownMeanMs = grown.meanMs;
  benchFindings.sizeRatio = grownBytes / smallBytes;
  // A loose ceiling only, so a hang is caught and a slow machine is not: the numbers above are the result.
  assert.ok(small.totalMs < 120_000, 'the small run finishes');
  assert.ok(grown.totalMs < 300_000, 'the grown run finishes');
  // Money still adds up after all of it.
  const wallet = await harness.readWallet(USER);
  assert.equal(wallet.balance, 400, 'every transaction applied exactly once');
});

test('the cost of a coin transaction does not grow with the size of the database', {
  todo: 'src/services/coinDatabase.js withCoinTransaction exports the whole database before the transaction (rollback copy) and again to write the file (persistCoinDatabase), so each transaction costs time proportional to the size of the database, on a single serial queue; the measurement above gives the numbers (a database 14 times larger made each transaction about three times slower)',
}, () => {
  assert.ok(benchFindings.smallMeanMs, 'the measurement ran');
  // Both runs are the same 200 transactions on the same machine, so the ratio does not depend on how fast it is. A
  // transaction that did not copy the whole file would cost about the same on both.
  assert.ok(benchFindings.grownMeanMs <= benchFindings.smallMeanMs * 1.5,
    `a database ${benchFindings.sizeRatio.toFixed(1)}x larger made a transaction ${(benchFindings.grownMeanMs / benchFindings.smallMeanMs).toFixed(1)}x slower`);
});
