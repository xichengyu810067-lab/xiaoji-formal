'use strict';

// Pins for the server-settings API.
//
// /set-welcome and /weather used to read and write utils/guildConfig directly. They now go
// through welcomeService.setWelcomeChannel and weatherService.getDefaultCity. Moving the call
// must not change anything a server can see, so these tests pin:
//   1. the exact bytes written to guildConfig.json, from every kind of starting file;
//   2. every reply text of both commands, and the extension hook /set-welcome completes with;
//   3. the new API functions against the functions they delegate to.
//
// guildConfig.json lives in a temporary retained-data root, so the real file is never touched.
// The expected file texts below were produced before the functions moved, not by the new functions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The retained-data root has to be set before anything loads guildConfig, and it only decides
// the file outside test-control mode.
delete process.env.XIAOJI_RUNTIME_MODE;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-guild-config-')));
require('../src/platform/retainedDataSource').configureRetainedDataSourceRoot(root);
const configFile = path.join(root, 'src', 'data', 'guildConfig.json');

const guildConfig = require('../src/utils/guildConfig');
const logger = require('../src/utils/logger');
const setWelcomeCommand = require('../src/commands/set-welcome');
const weatherCommand = require('../src/commands/weather');
const welcomeService = require('../src/services/welcomeService');
const weatherService = require('../src/services/weatherService');

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';
const THIRD_GUILD = '900000000000000003';
const CHANNEL = '910000000000000001';
const NO_MENTIONS = { parse: [], users: [], roles: [], repliedUser: false };

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- helpers ---------------------------------------------------------------------------------

const text = (...lines) => `${lines.join('\n')}\n`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function writeConfig(initial) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.rmSync(configFile, { recursive: true, force: true });
  if (initial !== null) fs.writeFileSync(configFile, initial, 'utf8');
}

const readConfig = () => fs.readFileSync(configFile, 'utf8');

// Runs the callback with the logger silenced; command failures are logged as warnings.
async function quietly(run) {
  const original = { info: logger.info, warn: logger.warn, error: logger.error };
  logger.info = () => {};
  logger.warn = () => {};
  logger.error = () => {};
  try {
    return await run();
  } finally {
    Object.assign(logger, original);
  }
}

// ---- starting files and the text each one must become ----------------------------------------

// Another guild with values that are not normalized, and one with a single field. A write for a
// new guild must carry both through untouched.
const OTHER_GUILDS = {
  [OTHER_GUILD]: {
    welcomeChannelId: '910000000000000002',
    weatherDefaultCity: '  Taipei  ',
    memory: { sharePublicAcrossChannels: true, extraMemoryKey: 7 },
    extensions: { synthetic: { enabled: true } },
    unknownKey: 'kept',
  },
  [THIRD_GUILD]: { weatherDefaultCity: 'Kaohsiung' },
};

// The target guild already has settings of its own, including a key the code does not know.
const KNOWN_GUILD = {
  [GUILD]: {
    welcomeChannelId: '910000000000000009',
    weatherDefaultCity: 'London',
    memory: { sharePublicAcrossChannels: true },
    extensions: { synthetic: { enabled: true } },
    unknownKey: 'kept',
  },
};

const NEW_GUILD_ENTRY = [
  `  "${GUILD}": {`,
  `    "welcomeChannelId": "${CHANNEL}",`,
  '    "weatherDefaultCity": null,',
  '    "memory": {',
  '      "sharePublicAcrossChannels": false',
  '    },',
  '    "extensions": {}',
  '  }',
];

const SCENARIOS = Object.freeze([
  {
    name: 'no file yet',
    initial: null,
    expected: text('{', ...NEW_GUILD_ENTRY, '}'),
  },
  {
    name: 'a file that cannot be parsed',
    initial: '{not json',
    expected: text('{', ...NEW_GUILD_ENTRY, '}'),
  },
  {
    name: 'other guilds with values that are not normalized',
    initial: json(OTHER_GUILDS),
    expected: text(
      '{',
      `  "${OTHER_GUILD}": {`,
      '    "welcomeChannelId": "910000000000000002",',
      '    "weatherDefaultCity": "  Taipei  ",',
      '    "memory": {',
      '      "sharePublicAcrossChannels": true,',
      '      "extraMemoryKey": 7',
      '    },',
      '    "extensions": {',
      '      "synthetic": {',
      '        "enabled": true',
      '      }',
      '    },',
      '    "unknownKey": "kept"',
      '  },',
      `  "${THIRD_GUILD}": {`,
      '    "weatherDefaultCity": "Kaohsiung"',
      '  },',
      ...NEW_GUILD_ENTRY.slice(0, -1),
      '  }',
      '}',
    ),
  },
  {
    name: 'the guild already has its own settings',
    initial: json(KNOWN_GUILD),
    expected: text(
      '{',
      `  "${GUILD}": {`,
      `    "welcomeChannelId": "${CHANNEL}",`,
      '    "weatherDefaultCity": "London",',
      '    "memory": {',
      '      "sharePublicAcrossChannels": true',
      '    },',
      '    "extensions": {',
      '      "synthetic": {',
      '        "enabled": true',
      '      }',
      '    },',
      '    "unknownKey": "kept"',
      '  }',
      '}',
    ),
  },
]);

// ---- 1. The bytes written to guildConfig.json ------------------------------------------------

test('setWelcomeChannel writes the same file as the function it delegates to', () => {
  for (const { name, initial, expected } of SCENARIOS) {
    writeConfig(initial);
    guildConfig.setGuildWelcomeChannel(GUILD, CHANNEL);
    assert.equal(readConfig(), expected, `setGuildWelcomeChannel: ${name}`);

    writeConfig(initial);
    welcomeService.setWelcomeChannel(GUILD, CHANNEL);
    assert.equal(readConfig(), expected, `setWelcomeChannel: ${name}`);
  }
});

test('setWelcomeChannel returns the stored channel, and an empty channel clears it', () => {
  writeConfig(null);
  assert.equal(welcomeService.setWelcomeChannel(GUILD, CHANNEL), CHANNEL);

  assert.equal(welcomeService.setWelcomeChannel(GUILD, ''), null);
  assert.equal(readConfig(), text(
    '{',
    `  "${GUILD}": {`,
    '    "welcomeChannelId": null,',
    '    "weatherDefaultCity": null,',
    '    "memory": {',
    '      "sharePublicAcrossChannels": false',
    '    },',
    '    "extensions": {}',
    '  }',
    '}',
  ));
});

test('/set-welcome writes the same file as before, for every kind of starting file', async () => {
  for (const { name, initial, expected } of SCENARIOS) {
    writeConfig(initial);
    const { interaction, replies } = createSetWelcomeInteraction();

    await setWelcomeCommand.execute(interaction);

    assert.equal(readConfig(), expected, name);
    assert.deepEqual(replies, [{ content: `新人歡迎頻道已設定為 <#${CHANNEL}>。`, ephemeral: true }], name);
  }
});

// ---- 2. /set-welcome -------------------------------------------------------------------------

function createChannel({ id = CHANNEL, textBased = true, botAllowed = true } = {}) {
  return {
    id,
    toString: () => `<#${id}>`,
    isTextBased: () => textBased,
    send: async () => {},
    permissionsFor: () => ({ has: () => botAllowed }),
  };
}

function createSetWelcomeInteraction({
  guildId = GUILD, inGuild = true, channel = createChannel(), fetchable = true, canManage = true,
} = {}) {
  const replies = [];
  const hooks = [];
  const interaction = {
    client: { extensionHost: { runHook: async (name, payload) => { hooks.push({ name, payload }); return []; } } },
    guild: {
      id: guildId,
      channels: { fetch: async (id) => (fetchable && id === channel.id ? channel : null) },
      members: { me: { id: '900000000000000099', permissions: {} }, fetch: async () => null },
    },
    guildId,
    channelId: 'room',
    commandName: 'set-welcome',
    user: { id: 'synthetic-admin' },
    memberPermissions: { has: () => canManage },
    replied: false,
    deferred: false,
    inGuild: () => inGuild,
    options: { getChannel: () => ({ id: channel.id }) },
    reply: async (payload) => { replies.push(payload); },
  };
  return { interaction, replies, hooks, channel };
}

test('/set-welcome replies the same text and completes with the same extension hook payload', async () => {
  writeConfig(null);
  const { interaction, replies, hooks, channel } = createSetWelcomeInteraction();

  await setWelcomeCommand.execute(interaction);

  assert.deepEqual(replies, [{ content: `新人歡迎頻道已設定為 <#${CHANNEL}>。`, ephemeral: true }]);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].name, 'publicCommandCompleted');
  assert.deepEqual(hooks[0].payload, {
    interaction,
    action: '/set-welcome',
    target: `${channel} (${CHANNEL})`,
    reason: '設定新人歡迎頻道',
  });
  assert.equal(hooks[0].payload.interaction, interaction);
  assert.equal(guildConfig.getGuildConfig(GUILD).welcomeChannelId, CHANNEL);
});

test('/set-welcome refuses with the same texts, and then leaves guildConfig.json and the hook alone', async () => {
  const cases = [
    ['outside a server', { inGuild: false }, '這個設定只能在伺服器內使用。'],
    ['a channel that cannot be fetched', { fetchable: false }, '找不到這個頻道，請重新選擇。'],
    ['a member without Manage Server', { canManage: false }, '你需要 Manage Server 權限才能使用 /set-welcome。'],
    ['a channel the bot may not use', { channel: createChannel({ botAllowed: false }) },
      '小吉需要 View Channel, Send Messages 權限才能執行 /set-welcome。'],
    ['a channel that is not text', { channel: createChannel({ textBased: false }) },
      '請選擇小吉可以傳送訊息的文字頻道。'],
  ];
  for (const [name, options, content] of cases) {
    writeConfig(json(OTHER_GUILDS));
    const before = readConfig();
    const { interaction, replies, hooks } = createSetWelcomeInteraction(options);

    await quietly(() => setWelcomeCommand.execute(interaction));

    assert.deepEqual(replies, [{ content, ephemeral: true }], name);
    assert.deepEqual(hooks, [], name);
    assert.equal(readConfig(), before, name);
  }
});

test('/set-welcome answers a storage failure with the same text and no hook', async () => {
  writeConfig(null);
  // A directory in place of the file: reading yields nothing, but the final rename cannot succeed.
  fs.rmSync(configFile, { force: true });
  fs.mkdirSync(configFile);
  try {
    const { interaction, replies, hooks } = createSetWelcomeInteraction();

    await quietly(() => setWelcomeCommand.execute(interaction));

    assert.deepEqual(replies, [{ content: '設定新人歡迎頻道失敗，請稍後再試。', ephemeral: true }]);
    assert.deepEqual(hooks, []);
  } finally {
    fs.rmSync(configFile, { recursive: true, force: true });
  }
});

// ---- 3. getDefaultCity and /weather ----------------------------------------------------------

const UNKNOWN_GUILD = '900000000000000099';
const NUMBER_CITY_GUILD = '900000000000000011';
const BLANK_CITY_GUILD = '900000000000000012';
const DEFAULT_CITY_FILE = {
  [GUILD]: { weatherDefaultCity: '  Taipei  ' },
  [OTHER_GUILD]: { weatherDefaultCity: 'x'.repeat(150) },
  [THIRD_GUILD]: { welcomeChannelId: CHANNEL },
};

test('getDefaultCity returns the stored city trimmed and capped, and null when there is none', () => {
  writeConfig(json(DEFAULT_CITY_FILE));

  assert.equal(weatherService.getDefaultCity(GUILD), 'Taipei');
  assert.equal(weatherService.getDefaultCity(OTHER_GUILD), 'x'.repeat(100));
  assert.equal(weatherService.getDefaultCity(THIRD_GUILD), null);
  assert.equal(weatherService.getDefaultCity(UNKNOWN_GUILD), null);
});

test('getDefaultCity answers like the guildConfig call /weather used to make, and never writes', () => {
  const file = json({
    ...DEFAULT_CITY_FILE,
    [NUMBER_CITY_GUILD]: { weatherDefaultCity: 12345 },
    [BLANK_CITY_GUILD]: { weatherDefaultCity: '   ' },
  });
  writeConfig(file);

  // Also for values nobody should store, whatever guildConfig makes of them.
  const guildIds = [GUILD, OTHER_GUILD, THIRD_GUILD, NUMBER_CITY_GUILD, BLANK_CITY_GUILD, UNKNOWN_GUILD];
  for (const guildId of guildIds) {
    assert.equal(weatherService.getDefaultCity(guildId), guildConfig.getGuildConfig(guildId).weatherDefaultCity, guildId);
  }
  assert.equal(readConfig(), file);
});

function weatherResponse(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const LONDON_REPORT = {
  name: 'London',
  sys: { country: 'GB' },
  weather: [{ description: '多雲' }],
  main: { temp_min: 10, temp_max: 12, feels_like: 9, humidity: 80 },
  wind: { speed: 3 },
};

// Runs with a fetch stand-in that records which city was asked for; no request leaves the process.
async function withWeatherProvider(answer, run) {
  const originalFetch = global.fetch;
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'OPENWEATHER_API_KEY');
  const originalKey = process.env.OPENWEATHER_API_KEY;
  const asked = [];
  process.env.OPENWEATHER_API_KEY = 'synthetic-openweather-key';
  global.fetch = async (url) => {
    asked.push(new URL(url).searchParams.get('q'));
    return answer();
  };
  try {
    await run(asked);
  } finally {
    global.fetch = originalFetch;
    if (hadKey) process.env.OPENWEATHER_API_KEY = originalKey;
    else delete process.env.OPENWEATHER_API_KEY;
  }
}

function createWeatherInteraction({ city = null, inGuild = true, guildId = GUILD } = {}) {
  const replies = [];
  const edits = [];
  const interaction = {
    guildId,
    channelId: 'room',
    user: { id: 'synthetic-weather-user' },
    options: { getString: (name) => (name === 'city' ? city : null) },
    inGuild: () => inGuild,
    reply: async (payload) => { replies.push(payload); },
    deferReply: async () => {},
    editReply: async (payload) => { edits.push(payload); },
  };
  return { interaction, replies, edits };
}

test('/weather without a city uses the server default, and an explicit city wins', async () => {
  writeConfig(json({ [GUILD]: { weatherDefaultCity: '  London  ' } }));
  await withWeatherProvider(async () => weatherResponse(200, LONDON_REPORT), async (asked) => {
    const fromDefault = createWeatherInteraction();
    await weatherCommand.execute(fromDefault.interaction);
    assert.deepEqual(asked, ['London']);
    const embed = fromDefault.edits[0].embeds[0].toJSON();
    assert.equal(embed.title, 'London, GB 今天天氣');
    assert.deepEqual(fromDefault.edits[0].allowedMentions, NO_MENTIONS);
    assert.deepEqual(fromDefault.replies, []);

    const explicit = createWeatherInteraction({ city: 'Paris' });
    await weatherCommand.execute(explicit.interaction);
    assert.deepEqual(asked, ['London', 'Paris']);
  });
});

test('/weather asks for a city, with the same text, when neither the member nor the server gave one', async () => {
  const ask = '請輸入城市，例如 `/weather city:Taipei`。若伺服器另有預設城市，請洽管理員確認。';
  writeConfig(json({ [GUILD]: { weatherDefaultCity: 'London' }, [OTHER_GUILD]: { welcomeChannelId: CHANNEL } }));
  await withWeatherProvider(async () => weatherResponse(200, LONDON_REPORT), async (asked) => {
    // A server without a default, and a default that cannot be used outside a server.
    const unset = createWeatherInteraction({ guildId: OTHER_GUILD });
    await weatherCommand.execute(unset.interaction);
    const direct = createWeatherInteraction({ inGuild: false });
    await weatherCommand.execute(direct.interaction);

    for (const { replies, edits } of [unset, direct]) {
      assert.deepEqual(replies, [{ content: ask, ephemeral: true, allowedMentions: NO_MENTIONS }]);
      assert.deepEqual(edits, []);
    }
    assert.deepEqual(asked, []);
  });
});

test('/weather never repeats an unknown default city in its error reply', async () => {
  writeConfig(json({ [GUILD]: { weatherDefaultCity: 'Atlantis' } }));
  await withWeatherProvider(async () => weatherResponse(404), async (asked) => {
    const lookup = createWeatherInteraction();
    await quietly(() => weatherCommand.execute(lookup.interaction));

    assert.deepEqual(asked, ['Atlantis']);
    assert.deepEqual(lookup.edits, [{ content: weatherService.CITY_NOT_FOUND_MESSAGE, allowedMentions: NO_MENTIONS }]);
    assert.equal(lookup.edits[0].content.includes('Atlantis'), false);
  });
});

// ---- the boundary this batch draws -----------------------------------------------------------

test('the two commands no longer load guildConfig themselves, and guildConfig keeps its exports', () => {
  const storage = require.resolve('../src/utils/guildConfig');
  for (const commandPath of ['../src/commands/set-welcome', '../src/commands/weather']) {
    const loaded = require.cache[require.resolve(commandPath)];
    assert.ok(loaded, commandPath);
    assert.equal(loaded.children.some((child) => child.filename === storage), false, commandPath);
  }
  assert.deepEqual(Object.keys(guildConfig).sort(), [
    'defaultGuildConfig',
    'getGuildConfig',
    'normalizeGuildConfig',
    'readAllGuildConfig',
    'setGuildConfig',
    'setGuildWelcomeChannel',
    'setWeatherDefaultCity',
    'updateGuildConfig',
    'writeAllGuildConfig',
  ]);
});
