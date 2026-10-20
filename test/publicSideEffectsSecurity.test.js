'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeRealTempDir } = require('./support/realTempDir');
const root = makeRealTempDir('xiaoji-public-effect-security-');
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');

const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const { buildReactionEffect } = require('../src/services/chainReactionDelivery');
const { startWordChain, acceptWordChainMessage } = require('../src/services/wordChainService');
const { createPublicEffectAuthority } = require('../src/platform/publicEffectGrant');
const { configurePublicEffectAdapter } = require('../src/platform/publicEffectAdapter');
const {
  configureChainReactionFence,
  proveReactionSourceWithApi,
} = require('../src/systems/safety/chainReactionFence');
const { initializePublicLedgers, openPublicLedgers } = require('./fixtures/publicLedgers');
const { createSyntheticRest } = require('./fixtures/syntheticRest');
const { PublicSideEffectRuntime } = require('../src/systems/safety/publicSideEffectRuntime');
const {
  buildWorkPenaltyAnnouncementBody,
  proveWorkPenaltySourceWithApi,
} = require('../src/systems/safety/workPenaltySource');

const DISCORD_EPOCH = 1_420_070_400_000n;
const CUTOVER = 1_700_000_000_000;
const BOT_ID = '10000000000000001';
const GUILD_ID = '10000000000000002';
const CHANNEL_ID = '10000000000000003';
const USER_ID = '10000000000000004';

function snowflake(timestamp, increment = 1n) {
  return (((BigInt(timestamp) - DISCORD_EPOCH) << 22n) + increment).toString();
}

function initializeLedgers(name) {
  return initializePublicLedgers({ root, name, botId: BOT_ID, cutover: CUTOVER });
}

// A runtime given the ledgers the way the bootstrap delivers them, and armed as at ready.
function createRuntime(name, rest) {
  const authority = createPublicEffectAuthority();
  const runtime = new PublicSideEffectRuntime({
    client: { rest: createSyntheticRest(rest) },
    botId: BOT_ID,
    env: {},
    now: () => CUTOVER + 10_000,
    effectAuthority: authority,
  });
  const ledgers = initializeLedgers(name);
  assert.deepEqual(runtime.preflight({
    ledgers: openPublicLedgers(ledgers, { botId: BOT_ID, now: () => CUTOVER + 10_000 }),
  }).disabled, []);
  runtime.arm();
  configurePublicEffectAdapter({ publicEffectRuntime: runtime, publicEffectIssuer: authority.createIssuer() });
  configureChainReactionFence(runtime);
  return { authority, runtime, ledgers };
}

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

test('plain penalty-shaped objects cannot mint a grant or dispatch without final authorization', async () => {
  let sends = 0;
  const rest = {
    options: { retries: 0 },
    put: async () => {},
    post: async () => {
      sends += 1;
      return { id: snowflake(CUTOVER + 3_000), channel_id: CHANNEL_ID };
    },
  };
  const { authority, runtime } = createRuntime('plain-penalty', rest);
  const effect = {
    purposeId: 'work.penalty.announce',
    action: 'work-penalty-message.create',
    target: CHANNEL_ID,
    method: 'POST',
    route: `/channels/${CHANNEL_ID}/messages`,
    body: { content: 'synthetic', allowed_mentions: { parse: [], users: [], roles: [], replied_user: false } },
  };
  const grant = authority.createIssuer().issuePenalty({
    botId: BOT_ID,
    guildId: GUILD_ID,
    penaltyId: 1,
    createdAt: new Date(CUTOVER + 1_000).toISOString(),
    sourceTimestampMs: CUTOVER + 1_000,
    effect,
  });
  assert.equal(grant, null);
  const result = await runtime.dispatch(grant, effect);
  assert.equal(result.kind, 'unavailable');
  assert.equal(sends, 0);
  await runtime.stop();
});

test('fake database APIs cannot mint a work penalty proof or reach the public transport', async () => {
  let sends = 0;
  const rest = {
    options: { retries: 0 },
    put: async () => {},
    post: async () => {
      sends += 1;
      return { id: snowflake(CUTOVER + 3_000), channel_id: CHANNEL_ID };
    },
  };
  const { authority, runtime } = createRuntime('fake-penalty-api', rest);
  const createdAt = new Date(CUTOVER + 1_000).toISOString();
  const row = {
    id: 1,
    guild_id: GUILD_ID,
    user_id: USER_ID,
    job_name: '測試職業',
    penalty_amount: 100,
    status: 'active',
    reason: '合成測試',
    announced_at: null,
    appeal_deadline_at: new Date(CUTOVER + 60_000).toISOString(),
    created_at: createdAt,
  };
  const body = buildWorkPenaltyAnnouncementBody({
    id: row.id,
    userId: row.user_id,
    jobName: row.job_name,
    penaltyAmount: row.penalty_amount,
    reason: row.reason,
    appealDeadlineAt: row.appeal_deadline_at,
  });
  const effect = {
    purposeId: 'work.penalty.announce',
    action: 'work-penalty-message.create',
    target: CHANNEL_ID,
    method: 'POST',
    route: `/channels/${CHANNEL_ID}/messages`,
    body,
  };
  const proof = proveWorkPenaltySourceWithApi({ get: () => row }, {
    botId: BOT_ID,
    guildId: GUILD_ID,
    penaltyId: row.id,
    createdAt,
    effect,
  });
  const grant = authority.createIssuer().issuePenalty(proof, effect);
  const result = await runtime.dispatch(grant, effect, { beforeAttempt: (begin) => begin() });

  assert.deepEqual({ proof: Boolean(proof), grant: Boolean(grant), sends, result: result.kind }, {
    proof: false,
    grant: false,
    sends: 0,
    result: 'unavailable',
  });
  await runtime.stop();
});

test('a stop after the begin and before REST sends nothing and writes nothing', async () => {
  resetCoinDatabaseForTests();
  fs.rmSync(process.env.COIN_DB_PATH, { force: true });
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  let sends = 0;
  const rest = { options: { retries: 0 }, post: async () => {}, put: async () => { sends += 1; return {}; } };
  const { authority, runtime, ledgers } = createRuntime('stop-after-begin', rest);
  await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
    seed: '地球', now: new Date(CUTOVER + 1_000) });
  const messageId = snowflake(CUTOVER + 2_000, 2n);
  const accepted = await acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
    messageId, userId: USER_ID, content: '球體', now: new Date(CUTOVER + 2_000) });
  const proof = await withCoinDatabase((api) => proveReactionSourceWithApi(api,
    { featureKey: 'word_chain', ...accepted.reactionSource }));
  const effect = buildReactionEffect('word_chain', CHANNEL_ID, messageId);
  const grant = authority.createIssuer().issueStoredChainReaction(proof, effect);

  let release;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const dispatch = runtime.dispatch(grant, effect, {
    beforeAttempt: async (begin) => {
      begin();
      entered();
      await gate;
    },
  });
  await enteredPromise;
  const stopping = runtime.stop();
  assert.equal(runtime.accepting, false);
  release();
  const outcome = await dispatch;
  await stopping;
  // begin() writes nothing; the ledger begin waits for the network entry, which a stopped
  // runtime refuses: unavailable, and the operation has no row.
  assert.equal(outcome.kind, 'unavailable');
  assert.equal(sends, 0);
  const reopened = openPublicLedgers(ledgers, { botId: BOT_ID, now: () => CUTOVER + 10_000 });
  try {
    assert.deepEqual(Object.keys(reopened.get('word-chain.reaction').getSnapshotForTests().operations), []);
  } finally {
    for (const ledger of reopened.values()) ledger.close();
  }
});

test('corrupt disabled chain config cannot be treated as empty by start or an implicit setting update', async () => {
  resetCoinDatabaseForTests();
  fs.rmSync(process.env.COIN_DB_PATH, { force: true });
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  const rest = { options: { retries: 0 }, post: async () => {}, put: async () => {} };
  const { runtime } = createRuntime('corrupt-start', rest);
  const timestamp = new Date(CUTOVER + 1_000).toISOString();
  await withCoinTransaction((api) => api.run(
    `INSERT INTO feature_guild_settings
      (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at)
     VALUES (?, 'word_chain', 0, NULL, '{broken', ?, ?)`,
    [GUILD_ID, timestamp, timestamp]
  ));
  await assert.rejects(startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
    seed: '地球', now: new Date(CUTOVER + 2_000) }), /CHAIN_REACTION_CONFIG_INVALID/u);
  const row = await withCoinDatabase((api) => api.get(
    "SELECT enabled, config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = 'word_chain'",
    [GUILD_ID]
  ));
  assert.deepEqual(row, { enabled: 0, config_json: '{broken' });
  assert.equal(runtime.getReactionFence('word-chain.reaction', GUILD_ID), null);
  await runtime.stop();
});
