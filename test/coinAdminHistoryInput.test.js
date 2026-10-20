'use strict';

// /coin-admin history without campaign-id looks up the transactions of one member. Asked without a
// member, or with campaign-only options, it says what to fill in, instead of a campaign text that
// reads as if campaign data were broken. The services are stand-ins; nothing is read or written.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const src = (...parts) => path.join(__dirname, '..', 'src', ...parts);

function loadCoinAdmin(t, { transactions = [] } = {}) {
  const lookups = [];
  const patches = [
    [require(src('utils', 'moderation.js')), 'ensureModerationAccess', async () => ({ ok: true })],
    [require(src('services', 'coinService.js')), 'getTransactions', async (...args) => {
      lookups.push(args);
      return transactions;
    }],
  ];
  const originals = patches.map(([target, key]) => target[key]);
  for (const [target, key, value] of patches) target[key] = value;
  const commandPath = require.resolve(src('commands', 'coin-admin.js'));
  delete require.cache[commandPath];
  const command = require(commandPath);
  t.after(() => {
    delete require.cache[commandPath];
    patches.forEach(([target, key], index) => { target[key] = originals[index]; });
  });
  return { command, lookups };
}

async function runHistory(command, values = {}) {
  const replies = [];
  const interaction = {
    commandName: 'coin-admin',
    id: 'history-interaction',
    guildId: 'history-guild',
    guild: { id: 'history-guild' },
    user: { id: 'history-admin' },
    replied: false,
    deferred: false,
    inGuild: () => true,
    options: {
      getSubcommand: () => 'history',
      getUser: (name) => values[name] ?? null,
      getRole: (name) => values[name] ?? null,
      getString: (name) => values[name] ?? null,
      getInteger: (name) => values[name] ?? null,
    },
    async reply(payload) {
      replies.push(payload);
      interaction.replied = true;
    },
    async editReply(payload) {
      replies.push(payload);
    },
  };
  await command.execute(interaction);
  return replies;
}

test('/coin-admin history with no options asks for the member and points at the other lookups', async (t) => {
  const { command, lookups } = loadCoinAdmin(t);
  const replies = await runHistory(command);
  assert.deepEqual(replies, [{
    content: '請用 user 選項指定要查詢交易紀錄的成員（可用 limit 調整筆數）。要看全伺服器最近的交易請用 /economy audit；活動歷史對帳請填 campaign-id。',
    ephemeral: true,
  }]);
  assert.doesNotMatch(replies[0].content, /活動資料不完整/u);
  assert.deepEqual(lookups, []);
});

const refusal = (names) => ({
  content: `${names.join('、')} 是活動歷史對帳用的選項，需要搭配 campaign-id；只查一般交易紀錄時請只填 user（可加 limit）。`,
  ephemeral: true,
});

// A value of the kind each option type carries (3 string, 4 integer, 8 role).
function sampleValue(option) {
  if (option.type === 8) return { id: 'role-1' };
  if (option.type === 4) return 2;
  return option.choices?.[0]?.value ?? 'synthetic';
}

test('every campaign-only history option, given without campaign-id, is named instead of ignored', async (t) => {
  const { command, lookups } = loadCoinAdmin(t);
  const history = command.data.toJSON().options.find((option) => option.name === 'history');
  const campaignOnly = history.options.filter((option) => !['user', 'limit', 'campaign-id'].includes(option.name));
  assert.deepEqual(campaignOnly.map((option) => option.name), ['action', 'audience', 'role', 'page', 'review-token',
    'reason', 'confirm', 'record-type', 'record-id', 'evidence-mode', 'source-reference', 'transaction-id']);
  const member = { id: 'member-1', username: 'member' };
  for (const option of campaignOnly) {
    // Alone, and next to a member, which would otherwise run the transaction lookup.
    for (const values of [{ [option.name]: sampleValue(option) }, { [option.name]: sampleValue(option), user: member }]) {
      assert.deepEqual(await runHistory(command, values), [refusal([option.name])], JSON.stringify(values));
    }
  }
  const several = { page: 3, reason: '核對', confirm: '已核對未發', user: member, limit: 5 };
  assert.deepEqual(await runHistory(command, several), [refusal(['page', 'reason', 'confirm'])]);
  assert.deepEqual(lookups, []);
});

test('/coin-admin history with a member still lists that member\'s transactions', async (t) => {
  const { command, lookups } = loadCoinAdmin(t);
  const target = { id: 'member-1', username: 'member', globalName: '成員甲' };
  const replies = await runHistory(command, { user: target, limit: 5 });
  assert.deepEqual(lookups, [['history-guild', 'member-1', { limit: 5 }]]);
  assert.deepEqual(replies, [{ content: '成員甲 目前沒有吉幣交易紀錄。', ephemeral: true }]);
});
