'use strict';

// A ✅ that could not be delivered marks its chain game broken on the status page. Before, nothing ever lifted that
// mark, so one old failure left number chain broken for good. A later delivery of the same feature now lifts it.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { makeRealTempDir } = require('./support/realTempDir');

const root = makeRealTempDir('xiaoji-outbox-health-');
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');

const { initializeNewCoinDatabase, resetCoinDatabaseForTests } = require('../src/services/coinDatabase');
const {
  claimFeatureOutbox,
  deadLetterFeatureOutbox,
  enqueueFeatureOutbox,
  listFeatureHealth,
  markFeatureOutboxDelivered,
  markFeatureOutboxDeliveredByDedupe,
  setFeatureHealth,
} = require('../src/services/featurePlatformService');

const GUILD = '900000000000000001';
const WORKER = 'worker-1';

async function health(featureKey) {
  return (await listFeatureHealth()).find((row) => row.featureKey === featureKey) || null;
}

async function claimOne(dedupeKey, featureKey = 'number_chain') {
  await enqueueFeatureOutbox({ guildId: GUILD, featureKey, eventType: 'discord_reaction', dedupeKey });
  const [event] = await claimFeatureOutbox({ workerId: WORKER, featureKey, eventType: 'discord_reaction', limit: 1 });
  assert.ok(event, `${dedupeKey} was claimed`);
  return event;
}

test.before(async () => {
  resetCoinDatabaseForTests();
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => resetCoinDatabaseForTests());

test('a dead letter marks the feature broken and the next delivery of that feature lifts the mark', async () => {
  const failed = await claimOne('message-1');
  await deadLetterFeatureOutbox(failed.id, { workerId: WORKER, error: new Error('reaction_unknown'), reason: 'max_attempts' });
  assert.equal((await health('number_chain')).status, 'broken');

  const delivered = await claimOne('message-2');
  assert.equal((await markFeatureOutboxDelivered(delivered.id, { workerId: WORKER })).updated, true);
  const after = await health('number_chain');
  assert.equal(after.status, 'normal');
  assert.equal(after.detail, null);
});

test('a delivery found by its dedupe key lifts the mark too', async () => {
  const failed = await claimOne('message-3');
  await deadLetterFeatureOutbox(failed.id, { workerId: WORKER, error: new Error('reaction_terminal'), reason: 'reaction_terminal' });
  assert.equal((await health('number_chain')).status, 'broken');

  await enqueueFeatureOutbox({ guildId: GUILD, featureKey: 'number_chain', eventType: 'discord_reaction', dedupeKey: 'message-4' });
  const result = await markFeatureOutboxDeliveredByDedupe({
    guildId: GUILD, featureKey: 'number_chain', eventType: 'discord_reaction', dedupeKey: 'message-4',
  });
  assert.equal(result.updated, true);
  assert.equal((await health('number_chain')).status, 'normal');
});

test('a delivery lifts only its own feature, and never a broken mark set for another reason', async () => {
  const failed = await claimOne('word-1', 'word_chain');
  await deadLetterFeatureOutbox(failed.id, { workerId: WORKER, error: new Error('reaction_unknown'), reason: 'max_attempts' });
  await setFeatureHealth('daily_riddle', 'broken', { detail: 'publish_failed' });

  const delivered = await claimOne('message-5');
  await markFeatureOutboxDelivered(delivered.id, { workerId: WORKER });
  assert.equal((await health('word_chain')).status, 'broken', 'another feature keeps its mark');
  assert.equal((await health('daily_riddle')).status, 'broken', 'a mark that no dead letter set stays');

  await setFeatureHealth('number_chain', 'broken', { detail: 'ledger_failed' });
  const again = await claimOne('message-6');
  await markFeatureOutboxDelivered(again.id, { workerId: WORKER });
  assert.equal((await health('number_chain')).status, 'broken', 'only a dead letter mark is lifted');
});
