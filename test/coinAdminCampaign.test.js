const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collection, MessagePayload, Options, Routes } = require('discord.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-coin-admin-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.BOT_OWNER_ID = 'owner-user';

const coinAdmin = require('../src/commands/coin-admin');
const { authorizeRoleAdd, cancelAddConfirmation, confirmUserAdd, createAddConfirmation,
  getAddConfirmation, roleAddPaymentGate } = require('../src/services/coinAdminAddService');
const {
  CoinCampaignError,
  applyOwnerCampaign,
  getOwnerCampaignHistoryReviewPlan,
  previewOwnerCampaign,
  reviewOwnerCampaignHistory,
} = require('../src/services/coinCampaignService');
const {
  initializeCoinDatabase,
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  setCoinDatabaseDurabilityForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const { setGuildEconomyEnabled } = require('../src/services/coinService');
const { getWalletPlayerWithApi, setDebtWithApi } = require('../src/services/coinWalletService');
const { grantRewardOnceV2WithApi } = require('../src/services/featurePlatformService');
const { installEgressGuard } = require('../src/platform/egressGuard');
const { createEgressLimiter } = require('../src/platform/egressLimiter');
const { createSyntheticRest } = require('./fixtures/syntheticRest');

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

function optionBag(subcommand, values = {}) {
  return {
    getSubcommand: () => subcommand,
    getUser: (name) => values[name] ?? null,
    getRole: (name) => values[name] ?? null,
    getString: (name) => values[name] ?? null,
    getInteger: (name) => values[name] ?? null,
  };
}

function slashInteraction(subcommand, values, guild = null, id = `slash-${Date.now()}`) {
  const output = { replies: [], edits: [] };
  const interaction = {
    id,
    commandName: 'coin-admin',
    guildId: guild?.id || 'guild-user',
    guild,
    user: { id: 'owner-user', tag: 'owner#0001' },
    options: optionBag(subcommand, values),
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

function componentInteraction(previewPayload, customId, guild, overrides = {}) {
  const output = { replies: [], edits: [], updates: [] };
  const interaction = {
    id: overrides.id || `button-${Math.random()}`,
    commandName: 'coin-admin',
    customId,
    guildId: overrides.guildId || guild.id,
    guild,
    user: { id: overrides.actorId || 'owner-user', tag: 'owner#0001' },
    message: { embeds: previewPayload.embeds },
    deferred: false,
    replied: false,
    isButton: () => true,
    async reply(payload) {
      this.replied = true;
      output.replies.push(payload);
    },
    async deferUpdate() {
      this.deferred = true;
    },
    async editReply(payload) {
      output.edits.push(payload);
    },
    async update(payload) {
      this.replied = true;
      output.updates.push(payload);
    },
  };
  return { interaction, output };
}

function buttonId(payload, index = 0) {
  const component = payload.components[0].components[index];
  return component.data?.custom_id || component.toJSON().custom_id;
}

function controlFrom(customId, guildId, actorUserId = 'owner-user') {
  const decoded = coinAdmin._test.parseAddCustomId(customId);
  return {
    ...decoded,
    actorUserId,
    guildId,
    nowSeconds: Math.floor(Date.now() / 1000),
  };
}

function member(id, roleIds, { bot = false, name = id } = {}) {
  return {
    id,
    displayName: name,
    partial: false,
    user: { id, username: name, bot },
    roles: { cache: { has: (roleId) => roleIds.includes(roleId) } },
  };
}

// Sends an editReply payload the way discord.js does (MessagePayload: body plus RawFile[]
// files, PATCH on the interaction webhook) through the egress guard and limiter, and returns
// what the synthetic transport received.
async function deliverEditReplyThroughEgress(payload) {
  const received = [];
  const rest = createSyntheticRest({ patch(route, request) { received.push({ route, ...request }); return { id: '34567890123456789' }; } });
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const limiter = createEgressLimiter();
  guard.setAdmission((details) => limiter.admit(details));
  const target = { client: { options: Options.createDefault() } };
  const { body, files } = await MessagePayload.create(target, payload).resolveBody().resolveFiles();
  await rest.patch(Routes.webhookMessage('45678901234567890', 'synthetic-token', '@original'), { body, files, auth: false });
  return received;
}

function guildWithMembers(id, members) {
  const collection = new Collection(members.map((entry) => [entry.id, entry]));
  return { id, memberCount: collection.size, members: { fetch: async () => collection } };
}

async function ensureWallet(guildId, userId, debt = 0) {
  await withCoinTransaction((api) => {
    getWalletPlayerWithApi(api, guildId, userId);
    if (debt > 0) setDebtWithApi(api, userId, debt);
  });
}

async function reviewEmptyCampaign(campaignId, userIds) {
  const plan = await getOwnerCampaignHistoryReviewPlan({
    campaignId,
    actorUserId: 'owner-user',
    userIds,
  });
  await reviewOwnerCampaignHistory({
    campaignId,
    actorUserId: 'owner-user',
    reviewId: 'a'.repeat(64),
    sourceSha256: plan.sourceSha256,
    decisions: userIds.map((userId) => ({
      userId,
      priorGrant: false,
      reviewedTransactionIds: [],
      reviewedLegacyGrantIds: [],
      reviewedAdminLogIds: [],
      reviewReason: 'synthetic no-prior-grant review',
    })),
  });
  return plan;
}

// The role preview of /coin-admin add for one campaign, as the owner sees it.
async function rolePreview(guild, role, { campaignId, operationId, amount, reason = 'synthetic role add' }) {
  const slash = slashInteraction('add', { role, amount, reason, 'campaign-id': campaignId }, guild, operationId);
  await coinAdmin.execute(slash.interaction);
  return slash.output.edits[0];
}

// Presses a button of a preview (0 confirm, 1 cancel) as the owner and returns what the press answered.
async function press(preview, guild, id, index = 0) {
  const pressed = componentInteraction(preview, buttonId(preview, index), guild, { id });
  await coinAdmin.handleComponent(pressed.interaction);
  return pressed.output;
}

// The last text a confirm press left on the preview.
function confirmText(output) {
  return output.edits.at(-1).content;
}

// Reconciles a role campaign's history through /coin-admin history (plan, then review), as the owner does.
async function reviewThroughHistory(guild, role, campaignId, idPrefix) {
  const plan = slashInteraction('history', { role, audience: 'role', action: 'plan', 'campaign-id': campaignId },
    guild, `${idPrefix}-plan`);
  await coinAdmin.execute(plan.interaction);
  const token = /批次核對識別碼：([a-f0-9]{64})/u.exec(plan.output.edits[0])[1];
  const review = slashInteraction('history', {
    role, audience: 'role', action: 'review', 'campaign-id': campaignId, 'review-token': token,
    reason: 'synthetic no-prior-grant review', confirm: '已核對未發',
  }, guild, `${idPrefix}-review`);
  await coinAdmin.execute(review.interaction);
  return review.output.edits[0];
}

// What a campaign paid: its receipts, the members' wallets, and the reward transactions behind them.
async function campaignLedger(campaignId, userIds) {
  const marks = userIds.map(() => '?').join(', ');
  return withCoinDatabase((api) => ({
    receipts: api.all('SELECT user_id, amount FROM reward_grants_v2 WHERE canonical_source_id = ? ORDER BY user_id',
      [campaignId]),
    wallets: api.all(`SELECT user_id, balance FROM coin_wallets WHERE user_id IN (${marks}) ORDER BY user_id`, userIds),
    payments: api.get(`SELECT COUNT(*) AS count FROM coin_transactions
      WHERE type = 'system_reward' AND user_id IN (${marks})`, userIds).count,
  }));
}

function unpaidLedger(userIds) {
  return { receipts: [], wallets: userIds.map((userId) => ({ user_id: userId, balance: 0 })), payments: 0 };
}

function paidLedger(userIds, amount) {
  return {
    receipts: userIds.map((userId) => ({ user_id: userId, amount })),
    wallets: userIds.map((userId) => ({ user_id: userId, balance: amount })),
    payments: userIds.length,
  };
}

// Calls `onStatement(sql)` before the coin database prepares each statement while `work` runs. A test uses it to reach
// one read inside a running press and queue another request right behind it: the coin database runs requests one at a
// time in the order they were queued, so that request runs before the press's next database step.
async function withStatementHook(onStatement, work) {
  const db = await withCoinDatabase((api) => api.db);
  db.prepare = function prepare(...args) {
    onStatement(String(args[0]));
    return Object.getPrototypeOf(this).prepare.apply(this, args);
  };
  try {
    return await work();
  } finally {
    delete db.prepare;
  }
}

async function roleCampaignSetup(guildId, roleId, userIds) {
  const role = { id: roleId, name: roleId };
  const guild = guildWithMembers(guildId, userIds.map((userId) => member(userId, [role.id])));
  await setGuildEconomyEnabled(guild.id, true, { operatorId: 'owner-user' });
  for (const userId of userIds) await ensureWallet(guild.id, userId);
  return { role, guild };
}

test('正式 Slash 只保留 add/history，add 的 user 與 role 均為選填二選一', async () => {
  const json = coinAdmin.data.toJSON();
  const names = json.options.map((option) => option.name);
  assert.deepEqual(names, ['add', 'remove', 'set', 'history', 'reset-user', 'enable', 'disable']);
  assert.equal(names.some((name) => name.startsWith('campaign-')), false);

  const add = json.options.find((option) => option.name === 'add');
  const addOptions = Object.fromEntries(add.options.map((option) => [option.name, option]));
  assert.equal(addOptions.user.required, false);
  assert.equal(addOptions.role.required, false);
  assert.equal(addOptions.amount.required, true);
  assert.equal(addOptions.reason.required, true);

  const history = json.options.find((option) => option.name === 'history');
  assert.deepEqual(history.options.find((option) => option.name === 'action').choices.map((choice) => choice.value),
    ['plan', 'review', 'classify', 'import']);

  const guild = guildWithMembers('guild-xor', [member('xor-user', ['xor-role'])]);
  const neither = slashInteraction('add', { amount: 10, reason: 'xor neither' }, guild, 'xor-neither');
  await coinAdmin.execute(neither.interaction);
  assert.match(neither.output.replies[0].content, /請確認發放對象/u);

  const both = slashInteraction('add', {
    user: { id: 'xor-user', username: 'Xor' },
    role: { id: 'xor-role', name: 'Xor role' },
    amount: 10,
    reason: 'xor both',
  }, guild, 'xor-both');
  await coinAdmin.execute(both.interaction);
  assert.match(both.output.replies[0].content, /請確認發放對象/u);
});

test('完整名單必須與穩定 memberCount 完全相符，角色名單排除 bot', async () => {
  const human = member('human', ['role']);
  const bot = member('bot', ['role'], { bot: true });
  const outsider = member('outsider', []);
  const guild = guildWithMembers('guild-members', [human, bot, outsider]);
  const fetched = await coinAdmin._test.fetchCompleteMembers(guild);
  assert.deepEqual(coinAdmin._test.selectNonBotRoleMembers(fetched, 'role').map((entry) => entry.id), ['human']);

  const incomplete = guildWithMembers('guild-incomplete', [human]);
  incomplete.memberCount = 2;
  await assert.rejects(coinAdmin._test.fetchCompleteMembers(incomplete),
    (error) => error.code === 'INCOMPLETE_MEMBER_FETCH');

  const changing = guildWithMembers('guild-changing', [human]);
  changing.members.fetch = async () => {
    changing.memberCount = 2;
    return new Collection([[human.id, human]]);
  };
  await assert.rejects(coinAdmin._test.fetchCompleteMembers(changing),
    (error) => error.code === 'INCOMPLETE_MEMBER_FETCH');

  const role = { id: 'role', name: 'Role' };
  const failedPreview = slashInteraction('add', {
    role,
    amount: 10,
    reason: 'must not persist partial fetch',
    'campaign-id': 'campaign-incomplete-fetch',
  }, incomplete, 'partial-fetch-operation');
  await coinAdmin.execute(failedPreview.interaction);
  assert.match(failedPreview.output.edits[0], /無法取得完整成員名單/u);
  const persisted = await withCoinDatabase((api) => api.get(
    'SELECT campaign_id FROM coin_owner_campaigns WHERE campaign_id = ?', ['campaign-incomplete-fetch']
  ));
  assert.equal(persisted, null);
});

test('單人私密預覽綁定 actor/guild/op/token/期限，重播與重啟不重複 admin_add', async () => {
  const guild = guildWithMembers('guild-user', [member('target-user', [])]);
  await setGuildEconomyEnabled(guild.id, false, { operatorId: 'owner-user' });
  await ensureWallet(guild.id, 'target-user', 40);
  const slash = slashInteraction('add', {
    user: { id: 'target-user', username: 'Target' },
    amount: 100,
    reason: 'synthetic manual add',
  }, guild, 'single-operation');
  await coinAdmin.execute(slash.interaction);
  const preview = slash.output.replies[0];
  assert.equal(preview.ephemeral, true);
  assert.match(preview.embeds[0].description, /不抵扣欠款/u);
  const customId = buttonId(preview);
  const stored = await getAddConfirmation('single-operation');
  await assert.rejects(() => confirmUserAdd({
    ...controlFrom(customId, guild.id, 'another-user'),
  }), (error) => error.code === 'PREVIEW_SCOPE_MISMATCH');
  await assert.rejects(() => confirmUserAdd({
    ...controlFrom(customId, guild.id), nowSeconds: stored.expiresAt + 1,
  }), (error) => error.code === 'PREVIEW_EXPIRED');
  await assert.rejects(() => createAddConfirmation({ ...stored, actorUserId: 'another-user' }),
    (error) => error.code === 'PREVIEW_CHANGED');
  await assert.rejects(() => createAddConfirmation({ ...stored, amount: 101 }),
    (error) => error.code === 'PREVIEW_CHANGED');

  const first = componentInteraction(preview, customId, guild, { id: 'single-confirm-1' });
  first.interaction.message.embeds = [{ fields: [{ name: '每人毛額', value: '999999' }] }];
  const second = componentInteraction(preview, customId, guild, { id: 'single-confirm-2' });
  await Promise.all([coinAdmin.handleComponent(first.interaction), coinAdmin.handleComponent(second.interaction)]);

  let state = await withCoinDatabase((api) => ({
    wallet: api.get('SELECT balance FROM coin_wallets WHERE user_id = ?', ['target-user']),
    debt: api.get('SELECT amount FROM coin_debts WHERE user_id = ?', ['target-user']),
    transactions: api.get("SELECT COUNT(*) AS count FROM coin_transactions WHERE user_id = ? AND type = 'admin_add'", ['target-user']),
    receipts: api.get("SELECT COUNT(*) AS count FROM coin_operation_receipts WHERE operation_id = 'single-operation'"),
    enabled: api.get('SELECT enabled FROM coin_guild_settings WHERE guild_id = ?', [guild.id]),
  }));
  assert.deepEqual(state, {
    wallet: { balance: 100 }, debt: { amount: 40 }, transactions: { count: 1 },
    receipts: { count: 1 }, enabled: { enabled: 0 },
  });

  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  const replay = componentInteraction(preview, customId, guild, { id: 'single-confirm-after-restart' });
  await coinAdmin.handleComponent(replay.interaction);
  state = await withCoinDatabase((api) => ({
    balance: api.get('SELECT balance FROM coin_wallets WHERE user_id = ?', ['target-user']).balance,
    transactions: api.get("SELECT COUNT(*) AS count FROM coin_transactions WHERE user_id = ? AND type = 'admin_add'", ['target-user']).count,
  }));
  assert.deepEqual(state, { balance: 100, transactions: 1 });

  const tooLateCancel = componentInteraction(preview, buttonId(preview, 1), guild, { id: 'single-cancel-after-confirm' });
  await coinAdmin.handleComponent(tooLateCancel.interaction);
  assert.match(tooLateCancel.output.updates[0].content, /已完成，不能取消/u);

  await ensureWallet(guild.id, 'cancelled-user');
  const cancelledSlash = slashInteraction('add', {
    user: { id: 'cancelled-user', username: 'Cancelled' }, amount: 55, reason: 'cancel wins',
  }, guild, 'single-cancel-operation');
  await coinAdmin.execute(cancelledSlash.interaction);
  const cancelledPreview = cancelledSlash.output.replies[0];
  const cancel = componentInteraction(cancelledPreview, buttonId(cancelledPreview, 1), guild, { id: 'single-cancel-first' });
  await coinAdmin.handleComponent(cancel.interaction);
  assert.match(cancel.output.updates[0].content, /已取消，不會發放/u);
  const delayed = componentInteraction(cancelledPreview, buttonId(cancelledPreview), guild, { id: 'single-delayed-confirm' });
  await coinAdmin.handleComponent(delayed.interaction);
  assert.match(delayed.output.edits[0].content, /已取消，沒有入帳/u);
  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  const restartedDelayed = componentInteraction(cancelledPreview, buttonId(cancelledPreview), guild,
    { id: 'single-delayed-confirm-after-restart' });
  await coinAdmin.handleComponent(restartedDelayed.interaction);
  const cancelledState = await withCoinDatabase((api) => ({
    balance: api.get("SELECT balance FROM coin_wallets WHERE user_id = 'cancelled-user'").balance,
    transactions: api.get("SELECT COUNT(*) AS count FROM coin_transactions WHERE user_id = 'cancelled-user'").count,
    receipt: api.get("SELECT COUNT(*) AS count FROM coin_operation_receipts WHERE operation_id = 'single-cancel-operation'").count,
    status: api.get("SELECT status FROM coin_admin_add_confirmations WHERE operation_id = 'single-cancel-operation'").status,
  }));
  assert.deepEqual(cancelledState, { balance: 0, transactions: 0, receipt: 0, status: 'cancelled' });
});

test('單人加幣預覽的到期時間是相對時間標記，不是原始秒數', async () => {
  const guild = guildWithMembers('guild-expiry-display', [member('expiry-target', [])]);
  const slash = slashInteraction('add', {
    user: { id: 'expiry-target', username: 'Expiry' }, amount: 10, reason: 'synthetic expiry display',
  }, guild, 'expiry-display-operation');
  await coinAdmin.execute(slash.interaction);
  const stored = await getAddConfirmation('expiry-display-operation');
  const expiry = slash.output.replies[0].embeds[0].fields.find((field) => field.name === '到期時間');
  assert.ok(expiry, 'the preview shows an expiry field');
  assert.equal(expiry.value, `<t:${stored.expiresAt}:R>`);
  assert.doesNotMatch(expiry.value, /^\d+$/u);
});

test('單人加幣完成訊息用成員顯示名稱，成員已離開時用帳號名，不顯示原始 ID', async () => {
  const members = new Map([['named-target', member('named-target', [], { name: '伺服器暱稱' })]]);
  const guild = {
    id: 'guild-name-reply',
    memberCount: members.size,
    members: { fetch: async (id) => {
      if (!members.has(id)) throw new Error('Unknown Member');
      return members.get(id);
    } },
  };
  await ensureWallet(guild.id, 'named-target');
  const slash = slashInteraction('add', {
    user: { id: 'named-target', username: 'Named' }, amount: 20, reason: 'synthetic named reply',
  }, guild, 'named-reply-operation');
  await coinAdmin.execute(slash.interaction);
  const preview = slash.output.replies[0];
  const confirm = componentInteraction(preview, buttonId(preview), guild, { id: 'named-reply-confirm' });
  await coinAdmin.handleComponent(confirm.interaction);
  const content = confirm.output.edits[0].content;
  assert.match(content, /^單人加幣完成。\n目標：伺服器暱稱\n/u);
  assert.doesNotMatch(content, /named-target/u);

  const leftGuild = { id: 'guild-left-reply', memberCount: 0, members: { fetch: async () => { throw new Error('Unknown Member'); } } };
  await ensureWallet(leftGuild.id, 'left-target');
  const leftSlash = slashInteraction('add', {
    user: { id: 'left-target', username: 'Left' }, amount: 20, reason: 'synthetic left reply',
  }, leftGuild, 'left-reply-operation');
  await coinAdmin.execute(leftSlash.interaction);
  const leftPreview = leftSlash.output.replies[0];
  const leftConfirm = componentInteraction(leftPreview, buttonId(leftPreview), leftGuild, { id: 'left-reply-confirm' });
  leftConfirm.interaction.client = {
    users: { fetch: async (id) => ({ id, username: 'left-account', globalName: '已離開的成員' }) },
  };
  await coinAdmin.handleComponent(leftConfirm.interaction);
  const leftContent = leftConfirm.output.edits[0].content;
  assert.match(leftContent, /^單人加幣完成。\n目標：已離開的成員\n/u);
  assert.doesNotMatch(leftContent, /left-target/u);
});

test('角色預覽列出完整非 bot 名單，history 整併核對後並行確認只發一次並抵扣欠款', async () => {
  const role = { id: 'reward-role', name: 'Reward' };
  const members = [
    member('role-user-1', [role.id], { name: 'Alpha' }),
    member('role-user-2', [role.id], { name: 'Beta' }),
    member('role-bot', [role.id], { bot: true, name: 'Bot' }),
    member('outside-user', [], { name: 'Outside' }),
  ];
  const guild = guildWithMembers('guild-role', members);
  await setGuildEconomyEnabled(guild.id, true, { operatorId: 'owner-user' });
  await ensureWallet(guild.id, 'role-user-1', 30);
  await ensureWallet(guild.id, 'role-user-2', 150);

  const slash = slashInteraction('add', {
    role,
    amount: 100,
    reason: 'synthetic role campaign',
    'campaign-id': 'campaign-role-1',
  }, guild, 'role-preview-operation');
  await coinAdmin.execute(slash.interaction);
  const preview = slash.output.edits[0];
  assert.equal(slash.output.defer.ephemeral, true);
  assert.equal(preview.files.length, 1);
  const attachment = preview.files[0].attachment.toString('utf8');
  assert.match(attachment, /role-user-1/u);
  assert.match(attachment, /role-user-2/u);
  assert.doesNotMatch(attachment, /role-bot/u);
  assert.doesNotMatch(attachment, /outside-user/u);
  // The member list leaves the bot as a file of the same reply.
  const delivered = await deliverEditReplyThroughEgress(preview);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].files.map((file) => file.name), ['coin-role-preview.txt']);
  assert.equal(delivered[0].files[0].data.toString('utf8'), attachment);
  const fields = new Map(preview.embeds[0].fields.map((field) => [field.name, field.value]));
  assert.equal(fields.get('預計抵扣'), '130');
  assert.equal(fields.get('預計淨額'), '70');

  const historyPlan = slashInteraction('history', {
    role,
    audience: 'role',
    action: 'plan',
    'campaign-id': 'campaign-role-1',
  }, guild, 'history-plan');
  await coinAdmin.execute(historyPlan.interaction);
  const planText = historyPlan.output.edits[0];
  const reviewToken = /批次核對識別碼：([a-f0-9]{64})/u.exec(planText)[1];
  const historyReview = slashInteraction('history', {
    role,
    audience: 'role',
    action: 'review',
    'campaign-id': 'campaign-role-1',
    'review-token': reviewToken,
    reason: 'synthetic no-prior-grant review',
    confirm: '已核對未發',
  }, guild, 'history-review');
  await coinAdmin.execute(historyReview.interaction);
  assert.match(historyReview.output.edits[0], /已記錄 2 人/u);

  const customId = buttonId(preview);
  const first = componentInteraction(preview, customId, guild, { id: 'role-confirm-1' });
  const second = componentInteraction(preview, customId, guild, { id: 'role-confirm-2' });
  await Promise.all([coinAdmin.handleComponent(first.interaction), coinAdmin.handleComponent(second.interaction)]);

  const state = await withCoinDatabase((api) => ({
    wallets: api.all("SELECT user_id, balance FROM coin_wallets WHERE user_id LIKE 'role-%' ORDER BY user_id"),
    debts: api.all("SELECT user_id, amount FROM coin_debts WHERE user_id LIKE 'role-%' ORDER BY user_id"),
    receipts: api.all("SELECT user_id, amount, debt_offset, net_amount FROM reward_grants_v2 WHERE canonical_source_id = 'campaign-role-1' ORDER BY user_id"),
  }));
  assert.deepEqual(state.wallets, [
    { user_id: 'role-user-1', balance: 70 },
    { user_id: 'role-user-2', balance: 0 },
  ]);
  assert.deepEqual(state.debts, [{ user_id: 'role-user-2', amount: 50 }]);
  assert.deepEqual(state.receipts, [
    { user_id: 'role-user-1', amount: 100, debt_offset: 30, net_amount: 70 },
    { user_id: 'role-user-2', amount: 100, debt_offset: 100, net_amount: 0 },
  ]);

  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  const replay = componentInteraction(preview, customId, guild, { id: 'role-confirm-after-restart' });
  await coinAdmin.handleComponent(replay.interaction);
  const afterRestart = await withCoinDatabase((api) => ({
    wallets: api.all("SELECT user_id, balance FROM coin_wallets WHERE user_id LIKE 'role-%' ORDER BY user_id"),
    receipts: api.get("SELECT COUNT(*) AS count FROM reward_grants_v2 WHERE canonical_source_id = 'campaign-role-1'").count,
  }));
  assert.deepEqual(afterRestart.wallets, state.wallets);
  assert.equal(afterRestart.receipts, 2);

  const tooLateCancel = componentInteraction(preview, buttonId(preview, 1), guild, { id: 'role-cancel-after-confirm' });
  await coinAdmin.handleComponent(tooLateCancel.interaction);
  assert.match(tooLateCancel.output.updates[0].content, /已完成，不能取消/u);
});

test('角色取消完成後，延遲與重啟後的 confirm 都不入帳', async () => {
  const role = { id: 'cancel-role', name: 'Cancel role' };
  const userId = 'cancel-role-user';
  const guild = guildWithMembers('guild-role-cancel', [member(userId, [role.id])]);
  await setGuildEconomyEnabled(guild.id, true, { operatorId: 'owner-user' });
  await ensureWallet(guild.id, userId);
  const slash = slashInteraction('add', {
    role, amount: 60, reason: 'cancelled role grant', 'campaign-id': 'campaign-role-cancel',
  }, guild, 'role-cancel-operation');
  await coinAdmin.execute(slash.interaction);
  const preview = slash.output.edits[0];
  const cancel = componentInteraction(preview, buttonId(preview, 1), guild, { id: 'role-cancel-first' });
  await coinAdmin.handleComponent(cancel.interaction);
  const delayed = componentInteraction(preview, buttonId(preview), guild, { id: 'role-delayed-confirm' });
  await coinAdmin.handleComponent(delayed.interaction);
  assert.match(delayed.output.edits[0].content, /已取消，沒有入帳/u);

  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  const restarted = componentInteraction(preview, buttonId(preview), guild, { id: 'role-delayed-after-restart' });
  await coinAdmin.handleComponent(restarted.interaction);
  const state = await withCoinDatabase((api) => ({
    balance: api.get('SELECT balance FROM coin_wallets WHERE user_id = ?', [userId]).balance,
    receipts: api.get('SELECT COUNT(*) AS count FROM reward_grants_v2 WHERE canonical_source_id = ?',
      ['campaign-role-cancel']).count,
    status: api.get("SELECT status FROM coin_admin_add_confirmations WHERE operation_id = 'role-cancel-operation'").status,
  }));
  assert.deepEqual(state, { balance: 0, receipts: 0, status: 'cancelled' });
});

test('角色發幣在伺服器吉幣停用時不入帳，且保留可續跑結果', async () => {
  const guildId = 'guild-role-disabled';
  const campaignId = 'campaign-role-disabled';
  const userId = 'disabled-role-user';
  await setGuildEconomyEnabled(guildId, false, { operatorId: 'owner-user' });
  await ensureWallet(guildId, userId, 20);
  const preview = await previewOwnerCampaign({
    campaignId,
    sourceGuildId: guildId,
    audienceType: 'role',
    roleId: 'disabled-role',
    actorUserId: 'owner-user',
    amount: 25,
    reason: 'synthetic disabled role campaign',
    memberIds: [userId],
  });
  await reviewEmptyCampaign(campaignId, [userId]);
  const applied = await applyOwnerCampaign({
    campaignId,
    sourceGuildId: guildId,
    audienceType: 'role',
    roleId: 'disabled-role',
    actorUserId: 'owner-user',
    previewToken: preview.previewToken,
    presentMemberIds: [userId],
  });
  assert.equal(applied.granted, 0);
  assert.deepEqual(applied.failed, [{ userId, code: 'COIN_DISABLED' }]);
  const state = await withCoinDatabase((api) => ({
    balance: api.get('SELECT balance FROM coin_wallets WHERE user_id = ?', [userId]).balance,
    debt: api.get('SELECT amount FROM coin_debts WHERE user_id = ?', [userId]).amount,
    receipts: api.get('SELECT COUNT(*) AS count FROM reward_grants_v2 WHERE canonical_source_id = ?', [campaignId]).count,
  }));
  assert.deepEqual(state, { balance: 0, debt: 20, receipts: 0 });
});

test('角色活動部分失敗後可續跑，已成功收件人不會重複入帳', async () => {
  const guildId = 'guild-partial';
  const campaignId = 'campaign-partial';
  const users = ['partial-ok', 'partial-retry'];
  const role = { id: 'partial-role', name: 'Partial role' };
  const guild = guildWithMembers(guildId, users.map((userId) => member(userId, [role.id])));
  await setGuildEconomyEnabled(guildId, true, { operatorId: 'owner-user' });
  await ensureWallet(guildId, users[0]);
  await ensureWallet(guildId, users[1]);
  const slash = slashInteraction('add', {
    role, amount: 25, reason: 'synthetic partial retry', 'campaign-id': campaignId,
  }, guild, 'role-partial-operation');
  await coinAdmin.execute(slash.interaction);
  const preview = slash.output.edits[0];
  await reviewEmptyCampaign(campaignId, users);
  await withCoinTransaction((api) => api.run(
    'UPDATE coin_wallets SET total_earned = ? WHERE user_id = ?',
    [Number.MAX_SAFE_INTEGER, users[1]],
  ));
  const first = componentInteraction(preview, buttonId(preview), guild, { id: 'role-partial-first' });
  await coinAdmin.handleComponent(first.interaction);
  assert.match(first.output.edits[0].content, /本輪新發 1 人/u);
  assert.match(first.output.edits[0].content, /失敗：1 人/u);
  assert.equal((await getAddConfirmation('role-partial-operation')).status, 'partial');

  const cancel = componentInteraction(preview, buttonId(preview, 1), guild, { id: 'role-partial-cancel' });
  await coinAdmin.handleComponent(cancel.interaction);
  assert.match(cancel.output.updates[0].content, /已開始處理，不能取消/u);

  await withCoinTransaction((api) => api.run(
    'UPDATE coin_wallets SET total_earned = 0 WHERE user_id = ?', [users[1]],
  ));
  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  const partialConfirmation = await getAddConfirmation('role-partial-operation');
  const resumedAfterExpiry = await authorizeRoleAdd({
    ...controlFrom(buttonId(preview), guild.id), nowSeconds: partialConfirmation.expiresAt + 1,
  });
  assert.equal(resumedAfterExpiry.status, 'partial');
  const second = componentInteraction(preview, buttonId(preview), guild, { id: 'role-partial-retry' });
  await coinAdmin.handleComponent(second.interaction);
  assert.match(second.output.edits[0].content, /本輪新發 1 人/u);
  assert.match(second.output.edits[0].content, /已領未重發：1 人/u);
  const state = await withCoinDatabase((api) => ({
    receipts: api.get('SELECT COUNT(*) AS count FROM reward_grants_v2 WHERE canonical_source_id = ?', [campaignId]).count,
    amounts: api.all('SELECT user_id, balance FROM coin_wallets WHERE user_id IN (?, ?) ORDER BY user_id', users),
    status: api.get("SELECT status FROM coin_admin_add_confirmations WHERE operation_id = 'role-partial-operation'").status,
  }));
  assert.equal(state.receipts, 2);
  assert.equal(state.status, 'completed');
  assert.deepEqual(state.amounts, [
    { user_id: 'partial-ok', balance: 25 },
    { user_id: 'partial-retry', balance: 25 },
  ]);
});

test('身分組確認在發出任何一筆前被歷史核對擋下：仍是 pending，可取消，取消後再確認與重啟都不入帳', async () => {
  const users = ['blocked-user-1', 'blocked-user-2'];
  const campaignId = 'campaign-blocked-cancel';
  const operationId = 'role-blocked-cancel-operation';
  const { role, guild } = await roleCampaignSetup('guild-blocked-cancel', 'blocked-role', users);
  const preview = await rolePreview(guild, role, { campaignId, operationId, amount: 40 });

  const blocked = await press(preview, guild, 'blocked-confirm');
  assert.equal(confirmText(blocked), '尚有歷史發款未完成核對，不能發幣。');
  assert.equal((await getAddConfirmation(operationId)).status, 'pending');

  // The same button pressed twice at once: both presses stop before paying anyone.
  const twice = await Promise.all([
    press(preview, guild, 'blocked-confirm-twice-1'), press(preview, guild, 'blocked-confirm-twice-2'),
  ]);
  assert.deepEqual(twice.map(confirmText), ['尚有歷史發款未完成核對，不能發幣。', '尚有歷史發款未完成核對，不能發幣。']);
  const stillPending = await getAddConfirmation(operationId);
  assert.deepEqual([stillPending.status, stillPending.result], ['pending', null]);
  assert.deepEqual(await campaignLedger(campaignId, users), unpaidLedger(users));

  const cancel = await press(preview, guild, 'blocked-cancel', 1);
  assert.equal(cancel.updates[0].content, '加幣操作已取消，不會發放。');
  assert.deepEqual(cancel.updates[0].components, []);
  assert.equal((await getAddConfirmation(operationId)).status, 'cancelled');

  // Reconciling the history afterwards does not bring the cancelled preview back.
  await reviewEmptyCampaign(campaignId, users);
  const late = await press(preview, guild, 'blocked-confirm-after-cancel');
  assert.equal(confirmText(late), '此加幣操作已取消，沒有入帳。');
  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  const restarted = await press(preview, guild, 'blocked-confirm-after-restart');
  assert.equal(confirmText(restarted), '此加幣操作已取消，沒有入帳。');
  assert.deepEqual(await campaignLedger(campaignId, users), unpaidLedger(users));
  assert.equal((await getAddConfirmation(operationId)).status, 'cancelled');
});

test('身分組確認被擋下後先核對歷史：再次確認（同時按兩次）每人只發一次，完成後不能取消', async () => {
  const users = ['reconcile-user-1', 'reconcile-user-2'];
  const campaignId = 'campaign-blocked-reconcile';
  const operationId = 'role-blocked-reconcile-operation';
  const { role, guild } = await roleCampaignSetup('guild-blocked-reconcile', 'reconcile-role', users);
  const preview = await rolePreview(guild, role, { campaignId, operationId, amount: 35 });

  assert.equal(confirmText(await press(preview, guild, 'reconcile-blocked')), '尚有歷史發款未完成核對，不能發幣。');
  assert.equal((await getAddConfirmation(operationId)).status, 'pending');
  assert.match(await reviewThroughHistory(guild, role, campaignId, 'reconcile-history'), /已記錄 2 人/u);

  const confirms = await Promise.all([
    press(preview, guild, 'reconcile-confirm-1'), press(preview, guild, 'reconcile-confirm-2'),
  ]);
  assert.deepEqual(await campaignLedger(campaignId, users), paidLedger(users, 35));
  assert.equal((await getAddConfirmation(operationId)).status, 'completed');
  // Each press answers with its own result, or says the add was already completed by the other; the ledger above shows
  // that between them each member was paid once.
  for (const output of confirms) {
    assert.match(confirmText(output),
      /^(?:活動：campaign-blocked-reconcile｜本輪新發 \d+ 人\n|此身分組活動已完成，沒有重複入帳。$)/u);
  }

  assert.equal(confirmText(await press(preview, guild, 'reconcile-confirm-again')), '此身分組活動已完成，沒有重複入帳。');
  const cancel = await press(preview, guild, 'reconcile-cancel', 1);
  assert.match(cancel.updates[0].content, /已完成，不能取消/u);
  assert.deepEqual(await campaignLedger(campaignId, users), paidLedger(users, 35));
});

test('身分組確認在第一筆入帳後中斷：重啟後是 partial，取消被拒，續跑只補發其餘成員', async () => {
  const users = ['crash-user-1', 'crash-user-2'];
  const campaignId = 'campaign-crash-after-first';
  const operationId = 'role-crash-after-first-operation';
  const { role, guild } = await roleCampaignSetup('guild-crash-after-first', 'crash-role', users);
  const preview = await rolePreview(guild, role, { campaignId, operationId, amount: 45 });
  await reviewEmptyCampaign(campaignId, users);

  // Keeps the database file as every write of the confirm left it: a crash right after a write leaves that file.
  const images = [];
  setCoinDatabaseDurabilityForTests({ filesystem: { ...fs, renameSync(from, to) {
    fs.renameSync(from, to);
    images.push(fs.readFileSync(to));
  } } });
  let confirmed;
  try {
    confirmed = await press(preview, guild, 'crash-confirm');
  } finally {
    setCoinDatabaseDurabilityForTests(null);
  }
  assert.match(confirmText(confirmed), /本輪新發 2 人/u);
  // The press writes the two payments and then its result; checking the press writes nothing.
  assert.equal(images.length, 3);

  // The crash right after the first payment: that payment and the state that forbids cancelling are on disk together.
  resetCoinDatabaseForTests();
  fs.writeFileSync(process.env.COIN_DB_PATH, images[0]);
  await initializeCoinDatabase();
  const crashed = await getAddConfirmation(operationId);
  assert.deepEqual([crashed.status, crashed.result], ['partial', null]);
  assert.deepEqual((await campaignLedger(campaignId, users)).receipts, [{ user_id: users[0], amount: 45 }]);

  const cancel = await press(preview, guild, 'crash-cancel', 1);
  assert.equal(cancel.updates[0].content, '加幣已開始處理，不能取消；請用確認按鈕安全續跑。');
  assert.equal((await getAddConfirmation(operationId)).status, 'partial');

  const resumed = await press(preview, guild, 'crash-resume');
  assert.match(confirmText(resumed), /本輪新發 1 人/u);
  assert.match(confirmText(resumed), /已領未重發：1 人/u);
  assert.equal((await getAddConfirmation(operationId)).status, 'completed');
  assert.deepEqual(await campaignLedger(campaignId, users), paidLedger(users, 45));
});

test('確認進行中、第一筆入帳前按取消：取消生效，該次確認一筆都不發', async () => {
  const users = ['race-before-user-1', 'race-before-user-2'];
  const campaignId = 'campaign-race-before-payment';
  const operationId = 'role-race-before-payment-operation';
  const { role, guild } = await roleCampaignSetup('guild-race-before-payment', 'race-before-role', users);
  const preview = await rolePreview(guild, role, { campaignId, operationId, amount: 25 });
  await reviewEmptyCampaign(campaignId, users);

  // The owner presses cancel while the confirm reads the member list, after the confirm was checked.
  let cancel = null;
  const members = await guild.members.fetch();
  const racingGuild = { ...guild, members: { fetch: async () => {
    cancel = await press(preview, guild, 'race-before-cancel', 1);
    return members;
  } } };
  const confirm = componentInteraction(preview, buttonId(preview), racingGuild, { id: 'race-before-confirm' });
  await coinAdmin.handleComponent(confirm.interaction);

  assert.equal(cancel.updates[0].content, '加幣操作已取消，不會發放。');
  assert.equal(confirmText(confirm.output), '此加幣操作已取消，沒有入帳。');
  assert.equal((await getAddConfirmation(operationId)).status, 'cancelled');
  assert.deepEqual(await campaignLedger(campaignId, users), unpaidLedger(users));
});

test('確認進行中、第一筆入帳後按取消：取消被拒，該次確認照常發完', async () => {
  const users = ['race-after-user-1', 'race-after-user-2'];
  const campaignId = 'campaign-race-after-payment';
  const operationId = 'role-race-after-payment-operation';
  const { role, guild } = await roleCampaignSetup('guild-race-after-payment', 'race-after-role', users);
  const preview = await rolePreview(guild, role, { campaignId, operationId, amount: 30 });
  await reviewEmptyCampaign(campaignId, users);

  // The first write of the confirm is its first payment; a cancel sent while it is written runs right after it.
  let cancelled = null;
  setCoinDatabaseDurabilityForTests({ filesystem: { ...fs, renameSync(from, to) {
    fs.renameSync(from, to);
    cancelled ??= cancelAddConfirmation(controlFrom(buttonId(preview, 1), guild.id));
  } } });
  let confirmed;
  try {
    confirmed = await press(preview, guild, 'race-after-confirm');
  } finally {
    setCoinDatabaseDurabilityForTests(null);
  }
  assert.equal((await cancelled).state, 'partial');
  assert.match(confirmText(confirmed), /本輪新發 2 人/u);
  assert.equal((await getAddConfirmation(operationId)).status, 'completed');
  assert.deepEqual(await campaignLedger(campaignId, users), paidLedger(users, 30));
});

test('每筆入帳都被拒（伺服器吉幣停用）時仍是 pending：可取消；同活動恢復後重新預覽確認才發放', async () => {
  const users = ['refused-user-1', 'refused-user-2'];
  const campaignId = 'campaign-all-refused';
  const { role, guild } = await roleCampaignSetup('guild-all-refused', 'refused-role', users);
  const refusedPreview = await rolePreview(guild, role, { campaignId, operationId: 'role-all-refused-operation', amount: 20 });
  await reviewEmptyCampaign(campaignId, users);
  await setGuildEconomyEnabled(guild.id, false, { operatorId: 'owner-user' });

  const refused = await press(refusedPreview, guild, 'all-refused-confirm');
  assert.match(confirmText(refused), /本輪新發 0 人/u);
  assert.match(confirmText(refused), /失敗：2 人/u);
  const stored = await getAddConfirmation('role-all-refused-operation');
  assert.equal(stored.status, 'pending');
  assert.deepEqual(stored.result.failed.map((item) => item.code), ['COIN_DISABLED', 'COIN_DISABLED']);
  const cancel = await press(refusedPreview, guild, 'all-refused-cancel', 1);
  assert.equal(cancel.updates[0].content, '加幣操作已取消，不會發放。');
  assert.deepEqual(await campaignLedger(campaignId, users), unpaidLedger(users));

  await setGuildEconomyEnabled(guild.id, true, { operatorId: 'owner-user' });
  const retried = await rolePreview(guild, role, { campaignId, operationId: 'role-all-refused-retry', amount: 20 });
  assert.match(confirmText(await press(retried, guild, 'all-refused-retry-confirm')), /本輪新發 2 人/u);
  assert.equal((await getAddConfirmation('role-all-refused-operation')).status, 'cancelled');
  assert.deepEqual(await campaignLedger(campaignId, users), paidLedger(users, 20));
});

test('活動付款閘門與入帳在同一交易：閘門失敗或不是同步函式則該筆整筆復原，閘門關閉則停在原處', async () => {
  const guildId = 'guild-payment-gate';
  const campaignId = 'campaign-payment-gate';
  const users = ['gate-user-1', 'gate-user-2'];
  await setGuildEconomyEnabled(guildId, true, { operatorId: 'owner-user' });
  for (const userId of users) await ensureWallet(guildId, userId);
  const audience = { campaignId, sourceGuildId: guildId, audienceType: 'role', roleId: 'gate-role',
    actorUserId: 'owner-user' };
  const preview = await previewOwnerCampaign({ ...audience, amount: 15, reason: 'synthetic payment gate',
    memberIds: users });
  await reviewEmptyCampaign(campaignId, users);
  const run = (paymentGate) => applyOwnerCampaign({ ...audience, previewToken: preview.previewToken,
    presentMemberIds: users, paymentGate });

  await assert.rejects(run({ open() {}, paid() { throw new Error('synthetic gate failure'); } }),
    /synthetic gate failure/u);
  assert.deepEqual(await campaignLedger(campaignId, users), unpaidLedger(users));

  // A gate step that returns a promise would finish outside the payment's transaction, so it stops the run.
  const asynchronous = (error) => error.code === 'INVALID_ARGUMENT' &&
    error.message === 'Payment gate steps must be synchronous.';
  await assert.rejects(run({ async open() {}, paid() {} }), asynchronous);
  await assert.rejects(run({ open() {}, async paid() {} }), asynchronous);
  assert.deepEqual(await campaignLedger(campaignId, users), unpaidLedger(users));

  let paid = 0;
  await assert.rejects(run({
    open() {
      if (paid > 0) throw new CoinCampaignError('ADD_CONFIRMATION_CLOSED', 'synthetic closed gate');
    },
    paid() { paid += 1; },
  }), (error) => error.code === 'ADD_CONFIRMATION_CLOSED');
  assert.equal(paid, 1);
  assert.deepEqual((await campaignLedger(campaignId, users)).receipts, [{ user_id: users[0], amount: 15 }]);

  await assert.rejects(run({ open() {} }), (error) => error.code === 'INVALID_ARGUMENT');
  const rest = await run(undefined);
  assert.deepEqual([rest.granted, rest.alreadyGranted, rest.failed], [1, 1, []]);
  assert.deepEqual(await campaignLedger(campaignId, users), paidLedger(users, 15));

  // A closed gate that reaches the command's general error answer reads as a finished add, not as a fault to retry.
  assert.equal(coinAdmin._test.campaignErrorReply(new CoinCampaignError('ADD_CONFIRMATION_CLOSED', 'closed')),
    '此加幣操作已取消或已完成，這次確認已停止發放，不會重複入帳。');
});

test('付款閘門在該筆入帳的交易內開啟：開啟時送出的取消只能排在這筆入帳之後，因而被拒', async () => {
  const users = ['gate-transaction-user-1', 'gate-transaction-user-2'];
  const campaignId = 'campaign-gate-transaction';
  const operationId = 'role-gate-transaction-operation';
  const { role, guild } = await roleCampaignSetup('guild-gate-transaction', 'gate-transaction-role', users);
  const preview = await rolePreview(guild, role, { campaignId, operationId, amount: 12 });
  await reviewEmptyCampaign(campaignId, users);
  const stored = await getAddConfirmation(operationId);

  // The add's real gate, watched: the first time it is opened, the owner's cancel is sent. Opened inside the payment's
  // transaction, the gate holds the database until that payment commits, so the cancel runs after the payment and is
  // refused. Opened in a read of its own before the payment, it would let the cancel in between.
  const real = roleAddPaymentGate(operationId);
  const steps = [];
  let cancelled = null;
  const watched = {
    open(api) {
      steps.push(['open', api]);
      cancelled ??= cancelAddConfirmation(controlFrom(buttonId(preview, 1), guild.id));
      return real.open(api);
    },
    paid(api) {
      steps.push(['paid', api]);
      return real.paid(api);
    },
  };
  const outcome = await applyOwnerCampaign({ campaignId, sourceGuildId: guild.id, audienceType: 'role',
    roleId: role.id, actorUserId: 'owner-user', previewToken: stored.previewToken, presentMemberIds: users,
    paymentGate: watched }).then((result) => ({ result }), (error) => ({ error }));

  assert.equal((await cancelled).state, 'partial');
  assert.equal(outcome.error, undefined);
  assert.deepEqual([outcome.result.granted, outcome.result.failed], [2, []]);
  assert.deepEqual(steps.map(([step]) => step), ['open', 'paid', 'open', 'paid']);
  assert.equal(steps[1][1], steps[0][1], 'the first payment is made in the transaction its gate was opened in');
  assert.equal(steps[3][1], steps[2][1], 'the second payment is made in the transaction its gate was opened in');
  assert.equal((await getAddConfirmation(operationId)).status, 'partial');
  assert.deepEqual(await campaignLedger(campaignId, users), paidLedger(users, 12));
});

test('每筆入帳都被拒、最後一次嘗試後才按取消：確認回已取消，不顯示結果也不留按鈕', async () => {
  const users = ['late-cancel-user-1', 'late-cancel-user-2'];
  const campaignId = 'campaign-late-cancel';
  const operationId = 'role-late-cancel-operation';
  const { role, guild } = await roleCampaignSetup('guild-late-cancel', 'late-cancel-role', users);
  const preview = await rolePreview(guild, role, { campaignId, operationId, amount: 18 });
  await reviewEmptyCampaign(campaignId, users);
  await setGuildEconomyEnabled(guild.id, false, { operatorId: 'owner-user' });

  // The press reads this add's row once to check the press, then once in the gate of each payment attempt. At the
  // third read, the gate of the last attempt, a cancel is queued: it runs after every attempt was refused and before
  // the press records its result, so only the recorded state tells the press that the add was cancelled.
  let reads = 0;
  let cancelled = null;
  const confirm = await withStatementHook((sql) => {
    if (/FROM coin_admin_add_confirmations WHERE operation_id/u.test(sql) && ++reads === 3) {
      cancelled = cancelAddConfirmation(controlFrom(buttonId(preview, 1), guild.id));
    }
  }, () => press(preview, guild, 'late-cancel-confirm'));

  assert.ok(cancelled, 'a cancel was queued at the gate of the last payment attempt');
  assert.equal((await cancelled).state, 'cancelled');
  assert.deepEqual(confirm.edits.at(-1),
    { content: '此加幣操作已取消，沒有入帳。', embeds: [], components: [], attachments: [] });
  const stored = await getAddConfirmation(operationId);
  assert.deepEqual([stored.status, stored.result], ['cancelled', null]);
  assert.deepEqual(await campaignLedger(campaignId, users), unpaidLedger(users));
});

test('同活動另一份預覽在這次確認讀過收據後先發給成員：這次只遇到已有收據，不算這筆操作入帳，仍可取消', async () => {
  const users = ['other-preview-user-1', 'other-preview-user-2'];
  const campaignId = 'campaign-other-preview';
  const amount = 22;
  const { role, guild } = await roleCampaignSetup('guild-other-preview', 'other-preview-role', users);
  const previewA = await rolePreview(guild, role, { campaignId, operationId: 'role-other-preview-a', amount });
  await rolePreview(guild, role, { campaignId, operationId: 'role-other-preview-b', amount });
  await reviewEmptyCampaign(campaignId, users);
  // When A is confirmed the second member has left, so A stays open to be resumed.
  const confirmGuild = guildWithMembers(guild.id, [member(users[0], [role.id])]);

  // B pays the first member right after A's press has read the campaign's receipts: B's payment transaction, through
  // B's own gate as a press of B makes it, is queued at that read and so runs before A's payment of that member.
  const gateB = roleAddPaymentGate('role-other-preview-b');
  let paidByB = null;
  const confirmA = await withStatementHook((sql) => {
    if (paidByB || !/SELECT user_id, amount FROM reward_grants_v2/u.test(sql)) return;
    paidByB = withCoinTransaction((api) => {
      gateB.open(api);
      const grant = grantRewardOnceV2WithApi(api, { kind: 'owner-campaign', canonicalSourceId: campaignId,
        rewardKind: 'campaign', userId: users[0], sourceGuildId: guild.id, amount, actorUserId: 'owner-user',
        metadata: { audienceType: 'role' } });
      if (!grant.alreadyGranted) gateB.paid(api);
      return grant;
    });
  }, () => press(previewA, confirmGuild, 'other-preview-a-confirm'));

  assert.ok(paidByB, 'B paid while A was being confirmed');
  assert.equal((await paidByB).alreadyGranted, false);
  const text = confirmText(confirmA);
  assert.match(text, /本輪新發 0 人/u);
  assert.match(text, /已領未重發：1 人/u);
  assert.match(text, /離群：1 人/u);
  assert.equal((await getAddConfirmation('role-other-preview-a')).status, 'pending');
  assert.equal((await getAddConfirmation('role-other-preview-b')).status, 'partial');
  const cancelA = await press(previewA, guild, 'other-preview-a-cancel', 1);
  assert.equal(cancelA.updates[0].content, '加幣操作已取消，不會發放。');
  assert.deepEqual((await campaignLedger(campaignId, users)).receipts, [{ user_id: users[0], amount }]);
});

test('v24 可從 v23 加入確認狀態且保留 v23 收據，不相容結構失敗不落盤', async () => {
  await withCoinTransaction((api) => {
    api.run('DROP TABLE coin_admin_add_confirmations');
    api.run("UPDATE coin_metadata SET value = '23' WHERE key = 'schema_version'");
  });
  resetCoinDatabaseForTests();
  const migrated = await initializeCoinDatabase();
  assert.equal(migrated.schemaVersion, 24);
  const contracts = await withCoinDatabase((api) => ({
    confirmationColumns: api.all('PRAGMA table_info(coin_admin_add_confirmations)').map((column) => column.name),
    gameReceiptColumns: api.all('PRAGMA table_info(game_launch_receipts)').map((column) => column.name),
  }));
  assert.deepEqual(contracts.confirmationColumns, [
    'operation_id', 'mode', 'actor_user_id', 'guild_id', 'target_user_id', 'role_id',
    'campaign_id', 'preview_token', 'amount', 'reason', 'expires_at', 'payload_hash',
    'status', 'result_json', 'created_at', 'updated_at',
  ]);
  assert.deepEqual(contracts.gameReceiptColumns,
    ['interaction_id', 'kind', 'user_id', 'guild_id', 'channel_id', 'payload_hash', 'result_json', 'created_at']);

  await withCoinTransaction((api) => {
    api.run('DROP TABLE coin_admin_add_confirmations');
    api.run('CREATE TABLE coin_admin_add_confirmations (operation_id TEXT PRIMARY KEY)');
    api.run("UPDATE coin_metadata SET value = '23' WHERE key = 'schema_version'");
  });
  resetCoinDatabaseForTests();
  const before = crypto.createHash('sha256').update(fs.readFileSync(process.env.COIN_DB_PATH)).digest('hex');
  await assert.rejects(() => initializeCoinDatabase(), (error) =>
    error.name === 'CoinDatabaseError' && /加幣確認狀態結構升級失敗/u.test(error.message));
  const after = crypto.createHash('sha256').update(fs.readFileSync(process.env.COIN_DB_PATH)).digest('hex');
  assert.equal(after, before);
});
