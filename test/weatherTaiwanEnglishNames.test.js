'use strict';

// A Taiwan place written in English (typed by a member, or saved as a server default by an older
// version, such as "Hsinchu") is read from CWA under its Chinese name when a CWA key is set: the
// reply names 新竹市, has wind direction and rain chance, and says CWA in its footer. Without a CWA
// key it keeps the OpenWeather lookup, and every OpenWeather reply now says so in its footer.
// Nothing leaves the process: fetch is a stand-in, and guildConfig.json lives in a temporary root.
// This file has its own process, so the CWA cache starts empty here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

delete process.env.XIAOJI_RUNTIME_MODE;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-weather-english-')));
require('../src/platform/retainedDataSource').configureRetainedDataSourceRoot(root);
const configFile = path.join(root, 'src', 'data', 'guildConfig.json');

const weatherCommand = require('../src/commands/weather');
const { getWeather } = require('../src/services/weatherService');
const { resolveTaiwanEnglishName } = require('../src/utils/weatherNLP');
const { getWeatherMentionReply } = require('../src/coordinators/conversationCoordinator');
const { officialWeekLocation } = require('./fixtures/cwaForecastFixtures');

const GUILD = '900000000000000011';
const CWA_HOST = 'opendata.cwa.gov.tw';
const OPENWEATHER_HOST = 'api.openweathermap.org';

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function taiwanDate(offset = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(Date.now() + offset * 86400000));
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function forecastDays() {
  return [0, 1, 2].map((offset) => ({
    date: taiwanDate(offset), weather: '多雲時晴', description: '多雲時晴。降雨機率 40%。',
    min: 22, max: 29, apparentMax: 31, humidity: 70,
    windSpeed: 4, beaufort: 3, windDirection: '東北風', pop: [20, 40],
  }));
}

// The nationwide county dataset (F-D0047-091), with the two cities these tests ask for.
function nationwideResponse() {
  const days = forecastDays();
  return {
    success: 'true',
    records: {
      Locations: [{
        LocationsName: '臺灣',
        Location: [
          officialWeekLocation({ name: '新竹市', geocode: '10018', days }),
          officialWeekLocation({ name: '臺北市', geocode: '63', days }),
        ],
      }],
    },
  };
}

const OPENWEATHER_CURRENT = {
  name: 'Hsinchu', sys: { country: 'TW' }, weather: [{ description: '多雲' }],
  main: { temp: 25, temp_min: 22, temp_max: 29, feels_like: 30, humidity: 70 }, wind: { speed: 3 },
};
const OPENWEATHER_FORECAST = {
  city: { name: 'Hsinchu', country: 'TW' },
  list: [0, 1].map((day) => ({
    dt: Math.floor(Date.now() / 1000) + day * 86400,
    main: { temp: 25, temp_min: 22, temp_max: 29, feels_like: 30, humidity: 70 },
    wind: { speed: 3 }, pop: 0.2, weather: [{ description: '多雲' }],
  })),
};

// Runs with the given keys set (and every other weather key removed) and a fetch stand-in that
// answers by host and records each request.
async function withProviders({ cwa = false, openWeather = true }, run) {
  const saved = { fetch: global.fetch, CWA_API_KEY: process.env.CWA_API_KEY, OPENWEATHER_API_KEY: process.env.OPENWEATHER_API_KEY };
  const requests = [];
  if (cwa) process.env.CWA_API_KEY = 'synthetic-cwa-key';
  else delete process.env.CWA_API_KEY;
  if (openWeather) process.env.OPENWEATHER_API_KEY = 'synthetic-openweather-key';
  else delete process.env.OPENWEATHER_API_KEY;
  global.fetch = async (url) => {
    const parsed = new URL(String(url));
    requests.push({ host: parsed.host, path: parsed.pathname, q: parsed.searchParams.get('q') });
    let body;
    if (parsed.host === CWA_HOST) body = nationwideResponse();
    else if (parsed.pathname.endsWith('/forecast')) body = OPENWEATHER_FORECAST;
    else body = OPENWEATHER_CURRENT;
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    await run(requests);
  } finally {
    global.fetch = saved.fetch;
    for (const key of ['CWA_API_KEY', 'OPENWEATHER_API_KEY']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function runSlash({ city = null, type = null, guildId = null } = {}) {
  const replies = [];
  const edits = [];
  await weatherCommand.execute({
    user: { id: 'weather-english-user' },
    guildId,
    channelId: 'weather-english-room',
    options: { getString: (name) => (name === 'city' ? city : name === 'type' ? type : null) },
    inGuild: () => Boolean(guildId),
    reply: async (payload) => { replies.push(payload); },
    deferReply: async () => {},
    editReply: async (payload) => { edits.push(payload); },
  });
  assert.deepEqual(replies, []);
  assert.equal(edits.length, 1);
  return edits[0].embeds[0].toJSON();
}

const fieldNames = (embed) => embed.fields.map((field) => field.name);

test('English Taiwan place names resolve to the Chinese county, city or district', () => {
  const cases = {
    Hsinchu: '新竹市',
    'Hsinchu, TW': '新竹市',
    'Hsinchu TW': '新竹市',
    'hsinchu city': '新竹市',
    'Hsinchu County': '新竹縣',
    'Taipei City, Taiwan': '臺北市',
    'New Taipei City': '新北市',
    Chiayi: '嘉義市',
    'Chiayi County': '嘉義縣',
    'Taitung County': '臺東縣',
    Zhubei: '新竹縣竹北市',
    'Zhongli District': '桃園市中壢區',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(resolveTaiwanEnglishName(input), expected, input);
  for (const overseas of ['London', 'Paris', 'Tokyo', 'New York', 'Atlantis', '', null]) {
    assert.equal(resolveTaiwanEnglishName(overseas), null, String(overseas));
  }
});

test('with a CWA key, /weather city:Hsinchu reads CWA and answers under the Chinese name with every field', async () => {
  await withProviders({ cwa: true }, async (requests) => {
    const weather = await getWeather('Hsinchu', 'today');
    assert.equal(weather.city, '新竹市');
    assert.equal(weather.source, 'cwa');
    assert.equal(weather.windDirection, '東北風');
    assert.equal(weather.pop, '40%');
    assert.equal(weather.sourceLabel, '中央氣象署預報');

    const embed = await runSlash({ city: 'Hsinchu' });
    assert.equal(embed.title, '新竹市 今日預報');
    assert.equal(embed.footer.text, '中央氣象署預報');
    assert.deepEqual(fieldNames(embed), ['溫度', '體感', '濕度', '風速', '風向', '降雨機率', '預報日期']);
    assert.doesNotMatch(JSON.stringify(embed), /Hsinchu|, TW/u);

    assert.equal((await getWeather('Taipei City, Taiwan', 'today')).city, '臺北市');
    assert.ok(requests.length >= 1);
    assert.ok(requests.every(({ host, path: route }) => host === CWA_HOST && route.endsWith('/F-D0047-091')),
      JSON.stringify(requests));
  });
});

test('a server default saved in English by an older version reads CWA too, not OpenWeather', async () => {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify({ [GUILD]: { weatherDefaultCity: 'Hsinchu' } }, null, 2)}\n`, 'utf8');
  const before = fs.readFileSync(configFile, 'utf8');
  await withProviders({ cwa: true }, async (requests) => {
    const embed = await runSlash({ guildId: GUILD });
    assert.equal(embed.title, '新竹市 今日預報');
    assert.equal(embed.footer.text, '中央氣象署預報');
    assert.ok(fieldNames(embed).includes('風向') && fieldNames(embed).includes('降雨機率'));
    assert.equal(requests.some(({ host }) => host === OPENWEATHER_HOST), false);
  });
  // The saved setting is read, never rewritten.
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
});

test('AI weather replies for an English Taiwan name use CWA as well', async () => {
  await withProviders({ cwa: true }, async () => {
    const reply = await getWeatherMentionReply('Hsinchu天氣');
    assert.match(reply, /^新竹市今天天氣：/u);
    assert.match(reply, /風向：東北風/u);
    assert.match(reply, /降雨機率：40%/u);
    assert.match(reply, /\n中央氣象署預報$/u);
  });
});

test('without a CWA key, an English name keeps the OpenWeather lookup and the reply says OpenWeather', async () => {
  await withProviders({ cwa: false }, async (requests) => {
    const today = await runSlash({ city: 'Hsinchu' });
    assert.equal(today.title, 'Hsinchu, TW 今天天氣');
    assert.equal(today.footer.text, 'OpenWeather 即時天氣');

    const week = await runSlash({ city: 'Hsinchu', type: 'week' });
    assert.equal(week.footer.text, 'OpenWeather 預報');
    const tomorrow = await runSlash({ city: 'Hsinchu', type: 'tomorrow' });
    assert.equal(tomorrow.footer.text, 'OpenWeather 預報');

    assert.equal(requests.some(({ host }) => host === CWA_HOST), false);
    assert.deepEqual(requests.map(({ q }) => q), ['Hsinchu', 'Hsinchu', 'Hsinchu']);
  });
});

test('with a CWA key, an overseas city still uses OpenWeather and says so', async () => {
  await withProviders({ cwa: true }, async (requests) => {
    const embed = await runSlash({ city: 'London' });
    assert.equal(embed.footer.text, 'OpenWeather 即時天氣');
    assert.deepEqual(requests.map(({ host, q }) => [host, q]), [[OPENWEATHER_HOST, 'London']]);
  });
});
