'use strict';

// A release delivery that became a dead letter (the send's outcome is unknown, or it failed every attempt) is never
// sent again on its own, and it kept the release announcements unhealthy for good: nothing could settle it. Only the
// Owner settles one now, as delivered (the announcement is in the channel) or abandoned (it is not, and is not to be
// sent late). Nothing is deleted, only a dead letter changes, and the health is worked out again at once. A synthetic
// database in a temporary directory is used.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { makeRealTempDir, removeRealTempDir } = require('./support/realTempDir');

const root = makeRealTempDir('xiaoji-release-dead-letter-');
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');
const OWNER_ID = '10000000000000777';
process.env.BOT_OWNER_ID = OWNER_ID;

const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
} = require('../src/systems/economy/storage/coinDatabase');
const {
  DEFAULT_REPOSITORY,
  FEATURE_KEY,
  listDeadLetterDeliveries,
  normalizeRelease,
  parseRepository,
  persistReleasesAndDeliveries,
  refreshReleaseAnnouncementHealth,
  resolveDeadLetterDelivery,
} = require('../src/services/releaseAnnouncementService');

const GUILD_A = '10000000000000901';
const GUILD_B = '10000000000000902';
const GUILD_C = '10000000000000903';
const NOW = new Date('2026-11-19T00:00:00.000Z');
const LATER = new Date('2026-11-19T01:00:00.000Z');

function rawRelease(id, tag, publishedAt) {
  return {
    id, tag_name: tag, draft: false, prerelease: false, published_at: publishedAt, name: `Release ${tag}`,
    body: '合成公開變更摘要', html_url: `https://github.com/${DEFAULT_REPOSITORY}/releases/tag/${tag}`,
  };
}

const repository = parseRepository(DEFAULT_REPOSITORY);
const BASELINE = normalizeRelease(rawRelease(3001, 'v1.1.2', '2026-09-29T00:00:00.000Z'), repository);
const CURRENT = normalizeRelease(rawRelease(3002, 'v1.2.0', '2026-10-20T00:00:00.000Z'), repository);

function rows() {
  return withCoinDatabase((api) => api.all(
    `SELECT guild_id, status, last_error, delivered_at, attempt_count, updated_at FROM release_announcement_deliveries
      WHERE release_id = ? ORDER BY guild_id`, [CURRENT.releaseId]));
}

async function setDelivery(guildId, status, lastError) {
  await withCoinDatabase((api) => api.run(`UPDATE release_announcement_deliveries
    SET status = ?, last_error = ?, attempt_count = 1 WHERE release_id = ? AND guild_id = ?`,
  [status, lastError, CURRENT.releaseId, guildId]));
}

function recorder() {
  const calls = [];
  const healthReporter = async (featureKey, status, { detail }) => { calls.push({ featureKey, status, detail }); };
  return { calls, healthReporter };
}

test.before(async () => {
  resetCoinDatabaseForTests();
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  // The baseline release first, with no guild; then the current one for three guilds.
  await persistReleasesAndDeliveries([BASELINE], [], NOW);
  await persistReleasesAndDeliveries([BASELINE, CURRENT], [GUILD_A, GUILD_B, GUILD_C], NOW);
});

test.after(() => {
  resetCoinDatabaseForTests();
  removeRealTempDir(root);
});

test('the Owner sees every dead letter with its release, guild and reason, and nobody else can settle one', async () => {
  await setDelivery(GUILD_A, 'dead_letter', 'SEND_RESULT_UNKNOWN');
  await setDelivery(GUILD_B, 'dead_letter', 'IN_FLIGHT_RESULT_UNKNOWN');
  await setDelivery(GUILD_C, 'delivered', null);

  const listed = await listDeadLetterDeliveries();
  assert.equal(listed.total, 2);
  assert.deepEqual(listed.deliveries.map(({ releaseId, guildId, tagName, reason }) => ({ releaseId, guildId, tagName, reason })), [
    { releaseId: CURRENT.releaseId, guildId: GUILD_A, tagName: 'v1.2.0', reason: 'SEND_RESULT_UNKNOWN' },
    { releaseId: CURRENT.releaseId, guildId: GUILD_B, tagName: 'v1.2.0', reason: 'IN_FLIGHT_RESULT_UNKNOWN' },
  ]);

  const before = await rows();
  for (const actorUserId of ['10000000000000555', '', null, undefined]) {
    await assert.rejects(resolveDeadLetterDelivery({
      releaseId: CURRENT.releaseId, guildId: GUILD_A, resolution: 'abandoned', actorUserId, now: LATER,
    }), { code: 'OWNER_ONLY' });
  }
  assert.deepEqual(await rows(), before);
});

test('arguments that are not a release ID, a guild ID and one of the two resolutions change nothing', async () => {
  const before = await rows();
  const bad = [
    { releaseId: 'v1.2.0', guildId: GUILD_A, resolution: 'delivered' },
    { releaseId: CURRENT.releaseId, guildId: '123', resolution: 'delivered' },
    { releaseId: CURRENT.releaseId, guildId: GUILD_A, resolution: 'deleted' },
    { releaseId: CURRENT.releaseId, guildId: GUILD_A, resolution: 'pending' },
  ];
  for (const input of bad) {
    await assert.rejects(resolveDeadLetterDelivery({ ...input, actorUserId: OWNER_ID, now: LATER }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(resolveDeadLetterDelivery({
    releaseId: CURRENT.releaseId, guildId: '10000000000000999', resolution: 'delivered', actorUserId: OWNER_ID, now: LATER,
  }), { code: 'NOT_FOUND' });
  // A delivery that is not a dead letter is not touched, whatever it is.
  await assert.rejects(resolveDeadLetterDelivery({
    releaseId: CURRENT.releaseId, guildId: GUILD_C, resolution: 'abandoned', actorUserId: OWNER_ID, now: LATER,
  }), { code: 'NOT_DEAD_LETTER', status: 'delivered' });
  assert.deepEqual(await rows(), before);
});

test('while a dead letter is left the feature stays broken, and settling the last one makes it normal at once', async () => {
  const health = recorder();
  assert.deepEqual(await refreshReleaseAnnouncementHealth({ healthReporter: health.healthReporter, now: LATER }), { backlog: 2 });
  assert.deepEqual(health.calls, [{ featureKey: FEATURE_KEY, status: 'broken', detail: 'delivery_backlog' }]);

  const confirmed = recorder();
  const delivered = await resolveDeadLetterDelivery({
    releaseId: CURRENT.releaseId, guildId: GUILD_A, resolution: 'delivered', actorUserId: OWNER_ID,
    now: LATER, healthReporter: confirmed.healthReporter,
  });
  assert.deepEqual(delivered, {
    releaseId: CURRENT.releaseId, guildId: GUILD_A, tagName: 'v1.2.0', previousReason: 'SEND_RESULT_UNKNOWN',
    status: 'delivered', note: 'OWNER_CONFIRMED_DELIVERED', backlog: 1,
  });
  assert.deepEqual(confirmed.calls, [{ featureKey: FEATURE_KEY, status: 'broken', detail: 'delivery_backlog' }]);

  const abandoned = recorder();
  const dropped = await resolveDeadLetterDelivery({
    releaseId: CURRENT.releaseId, guildId: GUILD_B, resolution: 'abandoned', actorUserId: OWNER_ID,
    now: LATER, healthReporter: abandoned.healthReporter,
  });
  assert.equal(dropped.backlog, 0);
  assert.deepEqual(abandoned.calls, [{ featureKey: FEATURE_KEY, status: 'normal', detail: null }]);

  // Nothing was deleted: the rows are there, with what was decided and when. A confirmed delivery has no delivery
  // time, because when it really arrived is not known.
  const byGuild = Object.fromEntries((await rows()).map((row) => [row.guild_id, row]));
  assert.deepEqual([byGuild[GUILD_A].status, byGuild[GUILD_A].last_error, byGuild[GUILD_A].delivered_at, byGuild[GUILD_A].updated_at],
    ['delivered', 'OWNER_CONFIRMED_DELIVERED', null, LATER.toISOString()]);
  assert.deepEqual([byGuild[GUILD_B].status, byGuild[GUILD_B].last_error, byGuild[GUILD_B].updated_at],
    ['suppressed', 'OWNER_ABANDONED', LATER.toISOString()]);
  assert.equal((await listDeadLetterDeliveries()).total, 0);

  // A settled delivery cannot be settled a second time.
  await assert.rejects(resolveDeadLetterDelivery({
    releaseId: CURRENT.releaseId, guildId: GUILD_A, resolution: 'abandoned', actorUserId: OWNER_ID, now: LATER,
  }), { code: 'NOT_DEAD_LETTER', status: 'delivered' });
});

test('an abandoned delivery is never queued again, even when the release is seen again', async () => {
  await persistReleasesAndDeliveries([BASELINE, CURRENT], [GUILD_A, GUILD_B, GUILD_C], LATER);
  const byGuild = Object.fromEntries((await rows()).map((row) => [row.guild_id, row]));
  assert.deepEqual([byGuild[GUILD_B].status, byGuild[GUILD_B].last_error], ['suppressed', 'OWNER_ABANDONED']);
  assert.deepEqual([byGuild[GUILD_A].status, byGuild[GUILD_A].last_error], ['delivered', 'OWNER_CONFIRMED_DELIVERED']);
});

test('a queued delivery after a failed attempt still counts against the health; a delivered one never does', async () => {
  await setDelivery(GUILD_C, 'pending', 'CHANNEL_UNAVAILABLE');
  const health = recorder();
  assert.deepEqual(await refreshReleaseAnnouncementHealth({ healthReporter: health.healthReporter, now: LATER }), { backlog: 1 });
  await setDelivery(GUILD_C, 'delivered', null);
  assert.deepEqual(await refreshReleaseAnnouncementHealth({ healthReporter: health.healthReporter, now: LATER }), { backlog: 0 });
});
