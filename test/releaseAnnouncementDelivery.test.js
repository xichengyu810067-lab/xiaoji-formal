'use strict';

// Release announcements after the guild review was removed. A guild is announced to when it has an explicit
// destination, whatever an earlier version recorded for it. A delivery an earlier version suppressed because
// its guild was not approved is never queued again (nothing is sent late), while one suppressed for a missing
// destination or an unavailable guild is queued again when that is put right, as before. Only fake Discord objects,
// a fake GitHub response and a synthetic database in a temporary directory are used.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

const { makeRealTempDir, removeRealTempDir } = require('./support/realTempDir');

const root = makeRealTempDir('xiaoji-release-delivery-');
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');

const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
} = require('../src/services/coinDatabase');
const {
  DEFAULT_REPOSITORY,
  FEATURE_KEY,
  normalizeRelease,
  parseRepository,
  persistReleasesAndDeliveries,
  processReleaseAnnouncementTick,
  readReleaseAnnouncementConfig,
} = require('../src/services/releaseAnnouncementService');

const BOT_ID = '10000000000000001';
const GUILD_A = '10000000000000901';
const GUILD_B = '10000000000000902';
const GUILD_C = '10000000000000903';
const GUILD_D = '10000000000000904';
const CHANNEL_ID = '10000000000000911';
const NOW = new Date('2026-10-14T00:00:00.000Z');

test.before(async () => {
  resetCoinDatabaseForTests();
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  resetCoinDatabaseForTests();
  removeRealTempDir(root);
});

function rawRelease(id, tag, publishedAt) {
  return {
    id, tag_name: tag, draft: false, prerelease: false, published_at: publishedAt, name: `Release ${tag}`,
    body: '合成公開變更摘要', html_url: `https://github.com/${DEFAULT_REPOSITORY}/releases/tag/${tag}`,
  };
}

const RAW_RELEASES = Object.freeze([
  rawRelease(2001, 'v1.1.1', '2026-09-20T00:00:00.000Z'),
  rawRelease(2002, 'v1.1.2', '2026-10-10T00:00:00.000Z'),
]);

function normalized() {
  const repository = parseRepository(DEFAULT_REPOSITORY);
  return RAW_RELEASES.map((raw) => normalizeRelease(raw, repository));
}

function deliveries() {
  return withCoinDatabase((api) => api.all(
    `SELECT release_id, guild_id, status, last_error, attempt_count FROM release_announcement_deliveries
      ORDER BY release_id, guild_id`).map((row) => ({ ...row, attempt_count: Number(row.attempt_count) })));
}

async function insertDelivery({ releaseId, guildId, status, lastError, attempts = 0 }) {
  const stamp = NOW.toISOString();
  await withCoinDatabase((api) => api.run(
    `INSERT INTO release_announcement_deliveries
      (release_id, guild_id, status, attempt_count, next_attempt_at, last_error, nonce, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [releaseId, guildId, status, attempts, stamp, lastError, `nonce-${releaseId}-${guildId}`, stamp, stamp]));
}

test('a delivery an earlier version suppressed as not approved is never queued again; the other suppressions still are', async () => {
  const [older, current] = normalized();
  // The first run only sets the baseline: no guild is listed yet.
  await persistReleasesAndDeliveries([older, current], [], NOW);
  assert.deepEqual(await deliveries(), []);

  // What an earlier version left: a guild suppressed as not approved, one suppressed for a missing destination, one
  // suppressed because it was unavailable, and one already delivered.
  await insertDelivery({ releaseId: current.releaseId, guildId: GUILD_A, status: 'suppressed', lastError: 'GUILD_NOT_APPROVED', attempts: 1 });
  await insertDelivery({ releaseId: current.releaseId, guildId: GUILD_B, status: 'suppressed', lastError: 'DESTINATION_NOT_CONFIGURED', attempts: 1 });
  await insertDelivery({ releaseId: current.releaseId, guildId: GUILD_C, status: 'suppressed', lastError: 'GUILD_UNAVAILABLE', attempts: 1 });
  await insertDelivery({ releaseId: current.releaseId, guildId: GUILD_D, status: 'delivered', lastError: null, attempts: 1 });

  const persisted = await persistReleasesAndDeliveries([older, current], [GUILD_A, GUILD_B, GUILD_C, GUILD_D], NOW);
  assert.equal(persisted.authoritativeCurrent, true);

  const byGuild = Object.fromEntries((await deliveries()).map((row) => [row.guild_id, row]));
  // Not approved: left suppressed as it was, with its attempt count and reason.
  assert.deepEqual([byGuild[GUILD_A].status, byGuild[GUILD_A].last_error, byGuild[GUILD_A].attempt_count],
    ['suppressed', 'GUILD_NOT_APPROVED', 1]);
  // A missing destination or an unavailable guild waits for the destination or the guild, and is queued again.
  assert.deepEqual([byGuild[GUILD_B].status, byGuild[GUILD_B].last_error, byGuild[GUILD_B].attempt_count],
    ['pending', null, 0]);
  assert.deepEqual([byGuild[GUILD_C].status, byGuild[GUILD_C].last_error, byGuild[GUILD_C].attempt_count],
    ['pending', null, 0]);
  assert.deepEqual([byGuild[GUILD_D].status, byGuild[GUILD_D].attempt_count], ['delivered', 1]);
  // The older release was never listed for any guild: nothing old is announced to anyone.
  assert.equal((await deliveries()).some((row) => row.release_id === older.releaseId), false);
});

function fakeGuild(id, send) {
  const channel = {
    id: CHANNEL_ID,
    guildId: id,
    type: ChannelType.GuildText,
    isThread: () => false,
    permissionsFor: () => ({
      has: (flag) => [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]
        .includes(flag),
    }),
    send,
  };
  return {
    id,
    available: true,
    channels: { cache: new Map([[CHANNEL_ID, channel]]) },
    members: { me: { id: BOT_ID, partial: false }, fetchMe: async () => ({ id: BOT_ID, partial: false }) },
  };
}

function releaseResponse(endpoint) {
  const body = JSON.stringify([...RAW_RELEASES]);
  return {
    ok: true,
    status: 200,
    url: endpoint,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    text: async () => body,
  };
}

test('a guild recorded as unknown, denied or not at all is announced to once it has a destination, and no review is asked', async () => {
  await withCoinDatabase((api) => api.run('DELETE FROM release_announcement_deliveries'));
  await withCoinDatabase((api) => api.run('DELETE FROM release_announcement_state'));
  await withCoinDatabase((api) => api.run('DELETE FROM github_releases'));
  fs.writeFileSync(process.env.XIAOJI_AUDIT_DATA_PATH, `${JSON.stringify({
    [GUILD_A]: { guildId: GUILD_A, status: 'unknown', manualAudit: true },
    [GUILD_B]: { guildId: GUILD_B, status: 'denied', reason: 'Audit timeout (24h)' },
  }, null, 2)}\n`);
  const auditBefore = fs.readFileSync(process.env.XIAOJI_AUDIT_DATA_PATH);

  const sent = { [GUILD_A]: [], [GUILD_B]: [], [GUILD_C]: [] };
  const guilds = [GUILD_A, GUILD_B, GUILD_C].map((id) => fakeGuild(id, async (message) => { sent[id].push(message); }));
  const client = { guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) } };
  const config = readReleaseAnnouncementConfig({});
  const result = await processReleaseAnnouncementTick(client, {
    config,
    now: NOW,
    fetchImpl: async (endpoint) => releaseResponse(endpoint),
    // Every guild has chosen its destination, except the last one, which has none.
    settingReader: async (guildId) => (guildId === GUILD_C
      ? { persisted: false, enabled: false, channelId: null }
      : { persisted: true, enabled: true, channelId: CHANNEL_ID }),
    healthReporter: async () => {},
    usageRecorder: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.eligibleGuilds, 2);
  assert.equal(result.delivered, 2);
  assert.equal(sent[GUILD_A].length, 1);
  assert.equal(sent[GUILD_B].length, 1);
  assert.deepEqual(sent[GUILD_C], []);
  assert.match(JSON.stringify(sent[GUILD_A][0]), /v1\.1\.2/u);
  assert.deepEqual((await deliveries()).map((row) => [row.guild_id, row.status]),
    [[GUILD_A, 'delivered'], [GUILD_B, 'delivered']]);
  assert.deepEqual(fs.readFileSync(process.env.XIAOJI_AUDIT_DATA_PATH), auditBefore);
  assert.equal(FEATURE_KEY, 'release_announcements');
});
