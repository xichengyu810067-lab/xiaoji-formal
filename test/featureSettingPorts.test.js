const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-feature-setting-ports-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');

const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/systems/economy/storage/coinDatabase');
const {
  getGuildFeatureSettingRowWithApi,
  listEnabledFeatureChannelsWithApi,
  upsertGuildFeatureSettingWithApi,
} = require('../src/services/featurePlatformService');
const { listEnabledDailyChannels } = require('../src/systems/community/daily/dailyEventKit');

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

const OLD_TIME = '2026-01-01T00:00:00.000Z';
const NEW_TIME = '2026-10-02T03:04:05.000Z';

// The statement the chain services carried before they wrote their setting through the feature platform.
const LEGACY_UPSERT = `INSERT INTO feature_guild_settings
      (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, feature_key) DO UPDATE SET
       enabled = excluded.enabled, channel_id = excluded.channel_id, config_json = excluded.config_json, updated_at = excluded.updated_at`;

const readRow = (guildId, featureKey) => withCoinDatabase((api) =>
  api.get('SELECT * FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?', [guildId, featureKey]));

function insertRow(api, guildId, featureKey, { enabled = 1, channelId = 'room', configJson = '{"kept":true}',
  createdAt = OLD_TIME, updatedAt = OLD_TIME } = {}) {
  api.run(
    `INSERT INTO feature_guild_settings
      (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [guildId, featureKey, enabled, channelId, configJson, createdAt, updatedAt]
  );
}

test('the row port returns the stored row with config_json unparsed, and nothing for a missing row', async () => {
  await withCoinTransaction((api) => {
    insertRow(api, 'row-guild', 'word_chain', { configJson: '{not json' });
    const row = getGuildFeatureSettingRowWithApi(api, 'row-guild', 'word_chain');
    assert.equal(row.config_json, '{not json');
    assert.equal(row.created_at, OLD_TIME);
    assert.equal(getGuildFeatureSettingRowWithApi(api, 'row-guild', 'number_chain') ?? null, null);
  });
});

test('the upsert port writes every column exactly as the statement the chains carried before', async () => {
  const scenarios = {
    'no row': null,
    'enabled row': { enabled: 1, channelId: 'old-room', configJson: '{"a":1}' },
    'disabled row': { enabled: 0, channelId: null, configJson: '{}' },
  };
  const writes = [
    { enabled: true, channelId: 'new-room', configJson: '{"b":2}' },
    { enabled: false, channelId: null, configJson: '{}' },
  ];
  let scenario = 0;
  for (const [label, starting] of Object.entries(scenarios)) {
    for (const write of writes) {
      scenario += 1;
      const legacyGuild = `upsert-${scenario}-legacy`;
      const portGuild = `upsert-${scenario}-port`;
      await withCoinTransaction((api) => {
        if (starting) {
          insertRow(api, legacyGuild, 'number_chain', starting);
          insertRow(api, portGuild, 'number_chain', starting);
        }
        const createdAt = starting ? OLD_TIME : NEW_TIME;
        api.run(LEGACY_UPSERT, [legacyGuild, 'number_chain', write.enabled ? 1 : 0, write.channelId, write.configJson,
          createdAt, NEW_TIME]);
        upsertGuildFeatureSettingWithApi(api, { guildId: portGuild, featureKey: 'number_chain', ...write,
          createdAt, updatedAt: NEW_TIME });
      });
      const { guild_id: legacyId, ...legacy } = await readRow(legacyGuild, 'number_chain');
      const { guild_id: portId, ...port } = await readRow(portGuild, 'number_chain');
      assert.equal(legacyId, legacyGuild);
      assert.equal(portId, portGuild);
      assert.deepEqual(port, legacy, `${label} / enabled ${write.enabled}`);
      assert.equal(port.created_at, starting ? OLD_TIME : NEW_TIME);
      assert.equal(port.updated_at, NEW_TIME);
    }
  }
});

test('an existing row keeps its created_at even when the port is handed another one', async () => {
  await withCoinTransaction((api) => {
    insertRow(api, 'keep-created', 'word_chain');
    upsertGuildFeatureSettingWithApi(api, { guildId: 'keep-created', featureKey: 'word_chain', enabled: false,
      channelId: null, configJson: '{}', createdAt: NEW_TIME, updatedAt: NEW_TIME });
  });
  const row = await readRow('keep-created', 'word_chain');
  assert.equal(row.created_at, OLD_TIME);
  assert.equal(row.enabled, 0);
  assert.equal(row.channel_id, null);
});

test('the ports join the caller transaction, so the caller rolling back removes the write', async () => {
  await assert.rejects(withCoinTransaction((api) => {
    upsertGuildFeatureSettingWithApi(api, { guildId: 'rolled-back', featureKey: 'word_chain', enabled: true,
      channelId: 'room', configJson: '{}', createdAt: NEW_TIME, updatedAt: NEW_TIME });
    assert.equal(getGuildFeatureSettingRowWithApi(api, 'rolled-back', 'word_chain').enabled, 1);
    throw new Error('caller aborts');
  }), /caller aborts/);
  assert.equal((await readRow('rolled-back', 'word_chain')) ?? null, null);
});

// The query the daily events ran before their settings went through the feature platform.
function legacyEnabledDaily(api, { featureKey, eventKind, localDate, limit, guildId = null }) {
  const params = [eventKind, localDate, featureKey];
  if (guildId) params.push(guildId);
  params.push(limit);
  return api.all(
    `SELECT settings.guild_id, settings.channel_id, settings.updated_at
     FROM feature_guild_settings AS settings
     LEFT JOIN daily_events AS event
       ON event.guild_id = settings.guild_id AND event.event_kind = ? AND event.local_date = ?
     WHERE settings.feature_key = ? AND settings.enabled = 1 AND settings.channel_id IS NOT NULL${guildId ? ' AND settings.guild_id = ?' : ''}
     ORDER BY CASE WHEN event.id IS NULL THEN 0 ELSE 1 END, settings.guild_id
     LIMIT ?`,
    params
  );
}

test('the enabled daily channels come in the same order and number as the joined query gave them', async () => {
  const localDate = '2026-10-02';
  await withCoinTransaction((api) => {
    for (const guildId of ['d-05', 'd-01', 'd-04', 'd-02', 'd-03', 'd-06']) {
      insertRow(api, guildId, 'daily_discussion', { channelId: `room-${guildId}`, configJson: '{}' });
    }
    insertRow(api, 'd-07', 'daily_discussion', { enabled: 0, channelId: 'room-d-07' });
    insertRow(api, 'd-08', 'daily_discussion', { channelId: null });
    insertRow(api, 'd-09', 'daily_riddle', { channelId: 'room-d-09' });
    const event = (guildId, eventKind, date) => api.run(
      `INSERT INTO daily_events
        (guild_id, event_kind, local_date, parent_channel_id, status, window_start_at, window_end_at,
         publish_marker, answer_marker, created_at, updated_at)
       VALUES (?, ?, ?, 'room', 'claimed', ?, ?, 'p', 'a', ?, ?)`,
      [guildId, eventKind, date, OLD_TIME, NEW_TIME, OLD_TIME, OLD_TIME]
    );
    event('d-01', 'discussion', localDate);
    event('d-04', 'discussion', localDate);
    event('d-02', 'riddle', localDate);
    event('d-03', 'discussion', '2026-10-01');
  });

  const cases = [
    { featureKey: 'daily_discussion', eventKind: 'discussion', localDate, limit: 100 },
    { featureKey: 'daily_discussion', eventKind: 'discussion', localDate, limit: 3 },
    { featureKey: 'daily_discussion', eventKind: 'discussion', localDate, limit: 5 },
    { featureKey: 'daily_discussion', eventKind: 'discussion', localDate, limit: 100, guildId: 'd-04' },
    { featureKey: 'daily_discussion', eventKind: 'discussion', localDate, limit: 100, guildId: 'd-07' },
    { featureKey: 'daily_riddle', eventKind: 'riddle', localDate, limit: 100 },
  ];
  for (const options of cases) {
    const expected = await withCoinDatabase((api) => legacyEnabledDaily(api, options));
    assert.deepEqual(await listEnabledDailyChannels(options), expected, JSON.stringify(options));
  }
  assert.deepEqual((await listEnabledDailyChannels(cases[0])).map((row) => row.guild_id),
    ['d-02', 'd-03', 'd-05', 'd-06', 'd-01', 'd-04']);
  assert.deepEqual(await withCoinDatabase((api) => listEnabledFeatureChannelsWithApi(api, 'daily_riddle')),
    [{ guild_id: 'd-09', channel_id: 'room-d-09', updated_at: OLD_TIME }]);
});
