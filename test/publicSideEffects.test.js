'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeRealTempDir } = require('./support/realTempDir');
const root = makeRealTempDir('xiaoji-public-effects-');
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');

const { initializeNewCoinDatabase, resetCoinDatabaseForTests, withCoinDatabase, withCoinTransaction } = require('../src/services/coinDatabase');
const { createPublicEffectAuthority } = require('../src/platform/publicEffectGrant');
const { configurePublicEffectAdapter } = require('../src/platform/publicEffectAdapter');
const { runWithHostOperationContext } = require('../src/platform/hostOperationContext');
const { configureChainReactionFence } = require('../src/systems/safety/chainReactionFence');
const { initializePublicLedgers, openPublicLedgers } = require('./fixtures/publicLedgers');
const { createSyntheticRest } = require('./fixtures/syntheticRest');
const { PublicSideEffectRuntime } = require('../src/systems/safety/publicSideEffectRuntime');
const {
  buildWorkPenaltyAnnouncementBody,
  proveWorkPenaltySourceWithApi,
} = require('../src/systems/safety/workPenaltySource');
const { dispatchImmediateChainReaction } = require('../src/services/chainReactionDelivery');
const { setGuildFeatureSetting } = require('../src/services/featurePlatformService');
const { startWordChain, acceptWordChainMessage, stopWordChain } = require('../src/services/wordChainService');
const { startNumberChain, acceptNumberChainMessage, processNumberChainReactionOutbox, stopNumberChain, MAX_TARGET } = require('../src/services/numberChainService');

const DISCORD_EPOCH = 1_420_070_400_000n;
const BOT_ID = '10000000000000001';
const GUILD_ID = '10000000000000002';
const CHANNEL_ID = '10000000000000003';
const USER_ID = '10000000000000004';
const CUTOVER = 1_700_000_000_000;

function snowflake(timestamp, increment = 1n) {
  return (((BigInt(timestamp) - DISCORD_EPOCH) << 22n) + increment).toString();
}

function initializeLedgers(name) {
  return initializePublicLedgers({ root, name, botId: BOT_ID, cutover: CUTOVER });
}

// A runtime given the ledgers the way the bootstrap delivers them, and armed as at ready.
function createRuntime(name, rest, ledgers = initializeLedgers(name)) {
  const authority = createPublicEffectAuthority();
  const runtime = new PublicSideEffectRuntime({ client: { rest: createSyntheticRest(rest) }, botId: BOT_ID,
    env: {}, now: () => CUTOVER + 10_000, effectAuthority: authority });
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

test('penalty result is durable, repairable, and never dispatched twice', async (t) => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  // The database is removed even when this test fails, so that the next test can create it again.
  t.after(() => {
    resetCoinDatabaseForTests();
    fs.rmSync(process.env.COIN_DB_PATH, { force: true });
  });
  let calls = 0;
  const rest = { options: { retries: 0 }, put: async () => {}, post: async (_route, options) => {
    calls += 1;
    assert.match(options.body.content, /合成測試/u);
    return { id: snowflake(CUTOVER + 3_000, 9n), channel_id: CHANNEL_ID };
  } };
  const { authority, runtime } = createRuntime('penalty', rest);
  const issuer = authority.createIssuer();
  const source = { botId: BOT_ID, guildId: GUILD_ID, penaltyId: 7,
    createdAt: new Date(CUTOVER + 1_000).toISOString(), sourceTimestampMs: CUTOVER + 1_000 };
  const penalty = { id: 7, userId: USER_ID, jobName: '測試職業', penaltyAmount: 250,
    reason: '合成測試', appealDeadlineAt: new Date(CUTOVER + 86_400_000).toISOString() };
  const effect = { purposeId: 'work.penalty.announce', action: 'work-penalty-message.create',
    target: CHANNEL_ID, method: 'POST', route: `/channels/${CHANNEL_ID}/messages`,
    body: buildWorkPenaltyAnnouncementBody(penalty) };
  await withCoinTransaction((api) => api.run(
    `INSERT INTO coin_work_penalties
      (id, guild_id, user_id, job_id, job_name, source_type, source_channel_id, penalty_date,
       daily_salary, penalty_amount, status, reason, appeal_deadline_at, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, 'synthetic', ?, '2023-11-14', 1000, ?, 'active', ?, ?, ?, ?)`,
    [penalty.id, GUILD_ID, USER_ID, penalty.jobName, CHANNEL_ID, penalty.penaltyAmount,
      penalty.reason, penalty.appealDeadlineAt, source.createdAt, source.createdAt]
  ));
  const proof = await withCoinTransaction((api) => proveWorkPenaltySourceWithApi(api, { ...source, effect }));
  const first = await runtime.dispatch(issuer.issuePenalty(proof, effect), effect, { beforeAttempt: (begin) => begin() });
  assert.equal(first.kind, 'confirmed');
  assert.equal(first.result.messageId, snowflake(CUTOVER + 3_000, 9n));
  const replayProof = await withCoinTransaction((api) => proveWorkPenaltySourceWithApi(api, { ...source, effect }));
  const replay = await runtime.dispatch(issuer.issuePenalty(replayProof, effect), effect, { beforeAttempt: (begin) => begin() });
  assert.equal(replay.kind, 'confirmed');
  assert.equal(calls, 1);
  await runtime.stop();
});

test('reaction uses one exact PUT and manual stop revokes an unattempted source', async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  const calls = [];
  const rest = { options: { retries: 0 }, post: async () => {}, put: async (route, options) => {
    calls.push({ route, options });
    return {};
  } };
  const { authority, runtime } = createRuntime('reaction', rest);
  const started = await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
    seed: '地球', now: new Date(CUTOVER + 1_000) });
  assert.equal(started.alreadyActive, false);
  await setGuildFeatureSetting(GUILD_ID, 'word_chain', { config: { custom: true }, now: new Date(CUTOVER + 1_500) });
  const preserved = await withCoinDatabase((api) => JSON.parse(api.get(
    "SELECT config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = 'word_chain'", [GUILD_ID]
  ).config_json));
  assert.equal(preserved.custom, true);
  assert.ok(preserved.corpusVersion);
  assert.ok(preserved._chainReaction);
  const messageId = snowflake(CUTOVER + 2_000, 11n);
  const accepted = await acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
    messageId, userId: USER_ID, content: '球體', now: new Date(CUTOVER + 2_000) });
  assert.ok(accepted.reactionSource);
  const eventGrant = authority.captureMessageCreate({ botId: BOT_ID, guildId: GUILD_ID,
    channelId: CHANNEL_ID, messageId, authorId: USER_ID, createdTimestamp: CUTOVER + 2_000 });
  const confirmed = await runWithHostOperationContext({ sourceEventId: messageId, publicEffectEventGrant: eventGrant },
    () => dispatchImmediateChainReaction({ rest }, 'word_chain', accepted.reactionSource,
      { permissionCheck: () => true }));
  assert.equal(confirmed.kind, 'confirmed');
  assert.deepEqual(calls, [{
    route: `/channels/${CHANNEL_ID}/messages/${messageId}/reactions/%E2%9C%85/@me`,
    options: { body: null },
  }]);

  const nextMessageId = snowflake(CUTOVER + 3_000, 12n);
  const next = await acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
    messageId: nextMessageId, userId: '10000000000000005', content: '體育', now: new Date(CUTOVER + 3_000) });
  assert.ok(next.reactionSource);
  await stopWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
    now: new Date(CUTOVER + 3_000) });
  const revokedGrant = authority.captureMessageCreate({ botId: BOT_ID, guildId: GUILD_ID,
    channelId: CHANNEL_ID, messageId: nextMessageId, authorId: '10000000000000005', createdTimestamp: CUTOVER + 3_000 });
  const revoked = await runWithHostOperationContext({ sourceEventId: nextMessageId, publicEffectEventGrant: revokedGrant },
    () => dispatchImmediateChainReaction({ rest }, 'word_chain', next.reactionSource,
      { permissionCheck: () => true }));
  assert.equal(revoked.kind, 'terminal');
  assert.equal(calls.length, 1);
  await runtime.stop();
});

test('completed number-chain outbox survives restart and a later stop closes its fence', async () => {
  resetCoinDatabaseForTests();
  fs.rmSync(process.env.COIN_DB_PATH, { force: true });
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  const firstRest = { options: { retries: 0 }, post: async () => {}, put: async () => { throw new Error('must not send before restart'); } };
  const first = createRuntime('completion-first', firstRest);
  const started = await startNumberChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
    now: new Date(CUTOVER + 1_000) });
  await withCoinTransaction((api) => api.run('UPDATE number_chain_sessions SET expected_target = ? WHERE id = ?',
    [MAX_TARGET, started.session.id]));
  const messageId = snowflake(CUTOVER + 2_000, 21n);
  const accepted = await acceptNumberChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
    messageId, userId: USER_ID, content: String(MAX_TARGET), now: new Date(CUTOVER + 2_000) });
  assert.equal(accepted.completed, true);
  assert.ok(accepted.reactionSource);
  await first.runtime.stop();

  let calls = 0;
  const secondRest = { options: { retries: 0 }, post: async () => {}, put: async () => { calls += 1; return {}; } };
  const second = createRuntime('completion-second', secondRest, first.ledgers);
  const summary = await processNumberChainReactionOutbox({ rest: secondRest },
    { permissionCheck: () => true });
  assert.equal(summary.delivered, 1, JSON.stringify(summary));
  assert.equal(calls, 1);
  const row = await withCoinDatabase((api) => api.get('SELECT status FROM number_chain_sessions WHERE id = ?', [started.session.id]));
  assert.equal(row.status, 'completed');
  await withCoinTransaction((api) => api.run(
    "UPDATE feature_guild_settings SET config_json = '{broken' WHERE guild_id = ? AND feature_key = 'number_chain'",
    [GUILD_ID]
  ));
  const stopped = await stopNumberChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID,
    now: new Date(CUTOVER + 3_000) });
  assert.equal(stopped.stopped, false);
  assert.equal(stopped.reactionRevoked, true);
  assert.equal(second.runtime.getReactionFence('number-chain.reaction', GUILD_ID).open, false);
  await second.runtime.stop();
});
