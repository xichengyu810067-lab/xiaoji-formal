'use strict';

// A weather question in chat is a sentence, not a place: "明天高雄會下雨嗎", "這週末台中天氣",
// "weather in Tokyo". These tests pin how a sentence is read (time, place, whether it is a weather
// question at all), what the chat reply says, the weekend forecast of the weather service, and that
// reading stays linear in the length of the sentence.
//
// Nothing leaves the process: fetch is a stand-in, the clock is a mock where the weekday matters,
// and the server settings live in a temporary data root. This file has its own process, so the CWA
// cache starts empty; each forecast scenario that is read at another mocked time uses a county of
// its own, so a cached dataset of one scenario is never read by another.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const environmentNames = ['XIAOJI_RUNTIME_MODE', 'XIAOJI_TEST_DATA_ROOT', 'XIAOJI_MEMORY_PATH', 'COIN_DB_PATH'];
const previousEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
process.env.XIAOJI_RUNTIME_MODE = 'test-control';
const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-weather-chat-')));
process.env.XIAOJI_TEST_DATA_ROOT = dataRoot;
process.env.XIAOJI_MEMORY_PATH = path.join(dataRoot, 'memory.json');
process.env.COIN_DB_PATH = path.join(dataRoot, 'coin.sqlite');
const guildConfigFile = path.join(dataRoot, 'guildConfig.json');

const {
  cleanWeatherLocationText,
  detectWeatherIntent,
  normalizeWeatherCommandLocation,
  OVERSEAS_CITIES,
  parseWeatherQuery,
  resolveOverseasCityName,
  TAIWAN_DISTRICTS,
} = require('../src/utils/weatherNLP');
const {
  CITY_NOT_FOUND_MESSAGE,
  FORECAST_UNAVAILABLE_MESSAGE,
  getWeather,
  WeatherError,
  weekendDayKeys,
} = require('../src/services/weatherService');
const {
  createConversationPorts,
  getWeatherMentionReply,
  isWeatherQuery,
} = require('../src/coordinators/conversationCoordinator');
const { handleMentionMessage } = require('../src/systems/conversation/chatFlow');
const { clearConversationStateForTests } = require('../src/services/conversationModeService');
const guildConfig = require('../src/utils/guildConfig');
const weatherCommand = require('../src/commands/weather');
const { officialWeekLocation, officialWeekResponse } = require('./fixtures/cwaForecastFixtures');

const GUILD = '900000000000000021';
const OTHER_GUILD = '900000000000000022';
const CWA_HOST = 'opendata.cwa.gov.tw';
const OPENWEATHER_HOST = 'api.openweathermap.org';

test.after(() => {
  for (const name of environmentNames) {
    if (previousEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnvironment[name];
  }
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function taiwanDate(offset = 0, from = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(from + offset * 86400000));
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

// The expected weekend days, worked out here on its own from the Taiwan date and weekday.
function expectedWeekend(from = Date.now()) {
  const today = taiwanDate(0, from);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const toSaturday = weekday === 0 ? -1 : 6 - weekday;
  return [toSaturday, toSaturday + 1]
    .map((offset) => taiwanDate(offset, from))
    .filter((key) => key >= today);
}

function forecastDays(count, from = Date.now()) {
  return Array.from({ length: count }, (_, index) => ({
    date: taiwanDate(index, from),
    weather: index % 2 ? '陰短暫雨' : '多雲時晴',
    description: '多雲時晴。降雨機率 40%。',
    min: 20 + index, max: 27 + index, apparentMax: 30 + index, humidity: 70 + index,
    windSpeed: 3 + index, beaufort: 2, windDirection: '東北風', pop: [10 + index, 20 + index],
  }));
}

function slashDate(date) {
  return date.slice(5).replace('-', '/');
}

// Runs with the given providers' keys set (every other weather key removed) and a fetch stand-in
// that records each request and answers by host and path.
async function withProviders({ cwa = null, openWeather = null }, run) {
  const saved = {
    fetch: global.fetch, CWA_API_KEY: process.env.CWA_API_KEY, OPENWEATHER_API_KEY: process.env.OPENWEATHER_API_KEY,
  };
  const requests = [];
  if (cwa) process.env.CWA_API_KEY = 'synthetic-cwa-key';
  else delete process.env.CWA_API_KEY;
  if (openWeather) process.env.OPENWEATHER_API_KEY = 'synthetic-openweather-key';
  else delete process.env.OPENWEATHER_API_KEY;
  global.fetch = async (url) => {
    const parsed = new URL(String(url));
    requests.push({
      host: parsed.host, path: parsed.pathname, q: parsed.searchParams.get('q'),
      dataset: parsed.pathname.split('/').at(-1),
    });
    const answer = parsed.host === CWA_HOST
      ? cwa
      : openWeather?.[parsed.pathname.endsWith('/forecast') ? 'forecast' : 'current'];
    if (answer === null || answer === undefined) {
      throw new Error(`a provider that this test did not set up was asked: ${parsed.host}${parsed.pathname}`);
    }
    const body = typeof answer === 'function' ? answer(parsed) : answer;
    if (body && body.status) return { ok: false, status: body.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    return await run(requests);
  } finally {
    global.fetch = saved.fetch;
    for (const key of ['CWA_API_KEY', 'OPENWEATHER_API_KEY']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// The nationwide county dataset (F-D0047-091) with the cities these tests ask for. The service keeps a
// dataset for 15 minutes, so every test that reads a city from this one lists the same cities, and
// none of them counts the requests made for it.
const NATIONWIDE_CITIES = ['高雄市', '臺北市', '桃園市', '臺中市', '新竹市'];
function nationwideResponse(days, names = NATIONWIDE_CITIES) {
  return {
    success: 'true',
    records: {
      Locations: [{
        LocationsName: '臺灣',
        Location: names.map((name, index) => officialWeekLocation({ name, geocode: String(63 + index), days })),
      }],
    },
  };
}

function districtResponse(county, district, geocode, days) {
  return officialWeekResponse({ county, district, geocode, days });
}

// An OpenWeather 5-day forecast of 3-hour steps that starts at `from`.
function openWeatherForecast(from, steps = 40, name = 'Tokyo', country = 'JP') {
  return {
    city: { name, country },
    list: Array.from({ length: steps }, (_, index) => ({
      dt: Math.floor(from / 1000) + index * 3 * 3600,
      main: { temp: 20, temp_min: 18, temp_max: 24, feels_like: 21, humidity: 60 },
      wind: { speed: 3 },
      pop: 0.3,
      weather: [{ description: '多雲' }],
    })),
  };
}

const OPENWEATHER_CURRENT = {
  name: 'Tokyo', sys: { country: 'JP' }, weather: [{ description: '晴' }],
  main: { temp: 20, temp_min: 18, temp_max: 24, feels_like: 21, humidity: 60 }, wind: { speed: 3 },
};

function writeGuildConfig(config) {
  fs.writeFileSync(guildConfigFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function summarize(query) {
  if (!query) return null;
  return {
    time: query.time,
    location: query.location,
    ambiguous: Boolean(query.ambiguous),
    invalid: Boolean(query.invalid),
  };
}

// ---------------------------------------------------------------------------
// How a sentence is read
// ---------------------------------------------------------------------------

test('the sentences members really send are read as place and time', () => {
  const place = (location, time) => ({ time, location, ambiguous: false, invalid: false });
  const cases = [
    ['台北天氣', place('臺北市', 'today')],
    ['明天高雄會下雨嗎', place('高雄市', 'tomorrow')],
    ['後天花蓮天氣', place('花蓮縣', 'day_after_tomorrow')],
    ['這週末台中天氣', place('臺中市', 'weekend')],
    ['週末台南天氣如何', place('臺南市', 'weekend')],
    ['桃園這禮拜天氣', place('桃園市', 'week')],
    ['這個星期新竹市天氣', place('新竹市', 'week')],
    ['台北今天要帶傘嗎', place('臺北市', 'today')],
    ['明天台北會不會下雨', place('臺北市', 'tomorrow')],
    ['高雄現在幾度', place('高雄市', 'today')],
    ['新北新莊天氣', place('新北市新莊區', 'today')],
    ['臺南東區天氣', place('臺南市東區', 'today')],
    ['北市大安區明天天氣', place('臺北市大安區', 'tomorrow')],
    ['嘉義市天氣', place('嘉義市', 'today')],
    ['澎湖天氣', place('澎湖縣', 'today')],
    ['宜蘭明天天氣如何', place('宜蘭縣', 'tomorrow')],
    ['東京天氣', place('Tokyo', 'today')],
    ['明天大阪會下雨嗎', place('Osaka', 'tomorrow')],
    ['Taipei weather tomorrow', place('臺北市', 'tomorrow')],
    ['weather in Tokyo', place('Tokyo', 'today')],
    ["what's the weather in Kaohsiung", place('高雄市', 'today')],
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(summarize(parseWeatherQuery(text)), expected, text);
  }
});

test('a place that is named wrongly or too loosely is asked about, with the candidates', () => {
  const hsinchu = parseWeatherQuery('新竹天氣怎麼樣');
  assert.ok(hsinchu.ambiguous);
  assert.equal(hsinchu.apiLocation, '');
  assert.deepEqual(new Set(hsinchu.candidates), new Set(['新竹縣', '新竹市']));

  const xinyi = parseWeatherQuery('信義區天氣');
  assert.ok(xinyi.ambiguous);
  assert.deepEqual(new Set(xinyi.candidates), new Set(['臺北市信義區', '基隆市信義區']));

  const east = parseWeatherQuery('東區今天會下雨嗎');
  assert.deepEqual(new Set(east.candidates), new Set(['臺中市東區', '臺南市東區', '新竹市東區', '嘉義市東區']));

  const chiayi = parseWeatherQuery('這週末嘉義天氣');
  assert.equal(chiayi.time, 'weekend');
  assert.deepEqual(new Set(chiayi.candidates), new Set(['嘉義縣', '嘉義市']));

  // The district is named and not the county: one answer for 新莊, two for 大安.
  assert.equal(parseWeatherQuery('新莊明天會下雨嗎').location, '新北市新莊區');
  assert.deepEqual(new Set(parseWeatherQuery('大安區今天會下雨嗎').candidates), new Set(['臺北市大安區', '臺中市大安區']));

  // A park or a zone is no district: only the county is read, and 新竹 is asked about.
  const park = parseWeatherQuery('請問明天在新竹科學園區的天氣');
  assert.equal(park.invalid, null);
  assert.deepEqual(new Set(park.candidates), new Set(['新竹縣', '新竹市']));
  assert.equal(parseWeatherQuery('台北科技園區天氣').location, '臺北市');

  // A county with a district it does not have is not answered with the county.
  const wrong = parseWeatherQuery('臺北市不存在區天氣');
  assert.ok(wrong.invalid);
  assert.equal(wrong.apiLocation, '');
});

test('particles and filler words never become part of the place', () => {
  const cases = [
    ['明天高雄會下雨嗎', '高雄市'],
    ['高雄會不會下雨呢', '高雄市'],
    ['請問一下高雄的天氣怎麼樣呢', '高雄市'],
    ['我想知道台北那邊現在有沒有在下雨', '臺北市'],
    ['台北市的天氣如何', '臺北市'],
    ['幫我查一下台中今天的氣溫', '臺中市'],
    ['台北大安會下雨嗎', '臺北市大安區'],
    ['我想知道新莊明天會不會下雨', '新北市新莊區'],
    ['板橋今天天氣怎麼樣呢', '新北市板橋區'],
    ['台北市區天氣', '臺北市'],
    ['新北投天氣', '臺北市北投區'],
    ['新竹市東區的天氣好不好', '新竹市東區'],
    ['高雄市鳳山區明天要帶傘嗎', '高雄市鳳山區'],
  ];
  for (const [text, location] of cases) {
    const query = parseWeatherQuery(text);
    assert.equal(query.location, location, text);
    assert.equal(query.ambiguous, null, text);
    assert.equal(query.invalid, null, text);
  }
});

test('every time word gives its time, the longer word first', () => {
  const groups = {
    weekend: ['週末', '周末', '這個週末', '這週末', '本週末', '禮拜六日', '星期六日', '假日', 'weekend', 'this weekend'],
    week: [
      '這禮拜', '這個禮拜', '本禮拜', '這星期', '這個星期', '本星期', '這幾天', '未來幾天', '這週', '本週', '一週',
      '七天', 'this week', 'next week', '下週', '下禮拜',
      // A day of the week is answered with the week, which holds it.
      '週五', '周三', '禮拜天', '星期一', '這週六', 'Friday',
    ],
    tomorrow: ['明天', '明日', '明早', '明晚', 'tomorrow'],
    day_after_tomorrow: ['後天', 'day after tomorrow'],
    today: ['今天', '今日', '現在', '目前', '今晚', '今早', 'tonight', 'today'],
  };
  for (const [time, words] of Object.entries(groups)) {
    for (const word of words) {
      const text = /^[a-z ]+$/u.test(word) ? `Taipei weather ${word}` : `台北${word}天氣`;
      const query = parseWeatherQuery(text);
      assert.equal(query.time, time, text);
      assert.equal(query.location, '臺北市', text);
    }
  }
  // No time word is today. A longer word beats a shorter word inside it.
  assert.equal(parseWeatherQuery('台北天氣').time, 'today');
  assert.equal(parseWeatherQuery('這週末台北天氣').time, 'weekend');
  assert.equal(parseWeatherQuery('這週台北天氣').time, 'week');
  assert.equal(parseWeatherQuery('這個禮拜六日台北天氣').time, 'weekend');
  assert.equal(parseWeatherQuery('this weekend Taipei weather').time, 'weekend');
});

test('a Chinese overseas city name becomes the English name, in a sentence and in the slash command', () => {
  assert.ok(OVERSEAS_CITIES.length >= 60, `${OVERSEAS_CITIES.length} cities`);
  for (const [english, chineseNames, otherEnglish] of OVERSEAS_CITIES) {
    for (const name of chineseNames) {
      const query = parseWeatherQuery(`${name}天氣`);
      assert.equal(query.location, english, name);
      assert.equal(query.apiLocation, english, name);
      assert.equal(query.city, null, name);
      assert.equal(normalizeWeatherCommandLocation(name).location, english, name);
      assert.equal(resolveOverseasCityName(name), english, name);
      // No time or filler word is read inside a city name.
      assert.equal(cleanWeatherLocationText(name), name, name);
      assert.equal(parseWeatherQuery(`明天${name}會下雨嗎`).location, english, name);
    }
    const lowerEnglish = english.toLowerCase().replace(/, [a-z]+$/u, '');
    for (const name of [lowerEnglish, ...otherEnglish]) {
      assert.equal(parseWeatherQuery(`weather in ${name}`).location, english, name);
    }
  }

  // The names the task asked for, with the English name the weather provider finds.
  const expected = {
    東京: 'Tokyo', 大阪: 'Osaka', 京都: 'Kyoto', 名古屋: 'Nagoya', 福岡: 'Fukuoka', 札幌: 'Sapporo',
    沖繩: 'Naha', 首爾: 'Seoul', 釜山: 'Busan', 曼谷: 'Bangkok', 清邁: 'Chiang Mai', 新加坡: 'Singapore',
    吉隆坡: 'Kuala Lumpur', 香港: 'Hong Kong', 澳門: 'Macau', 上海: 'Shanghai', 北京: 'Beijing', 深圳: 'Shenzhen',
    廣州: 'Guangzhou', 成都: 'Chengdu', 杭州: 'Hangzhou', 河內: 'Hanoi', 胡志明市: 'Ho Chi Minh City',
    峇里島: 'Denpasar', 馬尼拉: 'Manila', 雅加達: 'Jakarta', 紐約: 'New York', 洛杉磯: 'Los Angeles',
    舊金山: 'San Francisco', 西雅圖: 'Seattle', 芝加哥: 'Chicago', 波士頓: 'Boston', 華盛頓: 'Washington, US',
    拉斯維加斯: 'Las Vegas', 夏威夷: 'Honolulu', 溫哥華: 'Vancouver', 多倫多: 'Toronto', 倫敦: 'London',
    巴黎: 'Paris', 柏林: 'Berlin', 羅馬: 'Rome', 米蘭: 'Milan', 馬德里: 'Madrid', 巴塞隆納: 'Barcelona',
    阿姆斯特丹: 'Amsterdam', 維也納: 'Vienna', 蘇黎世: 'Zurich', 莫斯科: 'Moscow', 伊斯坦堡: 'Istanbul',
    杜拜: 'Dubai', 雪梨: 'Sydney', 墨爾本: 'Melbourne', 奧克蘭: 'Auckland', 孟買: 'Mumbai', 新德里: 'New Delhi',
    開羅: 'Cairo', 普吉島: 'Phuket',
  };
  for (const [chinese, english] of Object.entries(expected)) {
    assert.equal(normalizeWeatherCommandLocation(chinese).location, english, chinese);
    assert.equal(parseWeatherQuery(`${chinese}天氣`).location, english, chinese);
  }
  assert.equal(normalizeWeatherCommandLocation('上海市').location, 'Shanghai');
  assert.equal(resolveOverseasCityName('台北'), null);
  assert.equal(resolveOverseasCityName('Tokyo'), null);

  // The strict reading of a slash command is untouched for Taiwan and for names it does not know.
  assert.equal(normalizeWeatherCommandLocation('臺北市大安區').location, '臺北市大安區');
  assert.equal(normalizeWeatherCommandLocation('London').location, 'London');
  assert.ok(normalizeWeatherCommandLocation('新竹').ambiguous);
  assert.ok(normalizeWeatherCommandLocation('臺北市不存在區').invalid);
});

test('an English sentence is read for its place, and a Taiwan name is read as Taiwan', () => {
  const cases = [
    ['weather in Tokyo', 'Tokyo', 'today'],
    ['Weather in tokyo tomorrow', 'Tokyo', 'tomorrow'],
    ['what is the weather like in London today?', 'London', 'today'],
    ['how is the weather in New York next week', 'New York', 'week'],
    ["What's the forecast for San Francisco this weekend", 'San Francisco', 'weekend'],
    ['Will it rain in Paris tomorrow?', 'Paris', 'tomorrow'],
    ['weather in Ho Chi Minh City', 'Ho Chi Minh City', 'today'],
    ['weather in New Orleans', 'New Orleans', 'today'],
    ['Weather please, Berlin', 'Berlin', 'today'],
    ['weather in Lima, Peru', 'Lima', 'today'],
    ['Atlantis weather tomorrow', 'Atlantis', 'tomorrow'],
    ["Atlantis's weather", 'Atlantis', 'today'],
    ['請問 Atlantis 的天氣怎麼樣', 'Atlantis', 'today'],
    ['Taipei weather tomorrow', '臺北市', 'tomorrow'],
    ['weather in Taipei, Taiwan', '臺北市', 'today'],
    ['What is the weather in Kaohsiung City', '高雄市', 'today'],
    ['weather in New Taipei', '新北市', 'today'],
    ['Hsinchu weather', '新竹市', 'today'],
    ['weather in Hsinchu County', '新竹縣', 'today'],
    ['TAIPEI WEATHER', '臺北市', 'today'],
    ['ＴＡＩＰＥＩ　ＷＥＡＴＨＥＲ　ＴＯＭＯＲＲＯＷ', '臺北市', 'tomorrow'],
    ['London天氣', 'London', 'today'],
    ['明天 Paris 天氣', 'Paris', 'tomorrow'],
    ['Hsinchu天氣', '新竹市', 'today'],
  ];
  for (const [text, location, time] of cases) {
    const query = parseWeatherQuery(text);
    assert.equal(query.location, location, text);
    assert.equal(query.time, time, text);
    assert.equal(query.ambiguous, null, text);
  }
  // A name that is only a guess is taken under a strong word, and never under a medium word (下雨,
  // rain, 幾度, temperature): there the sentence asks for a place, and is not answered for the
  // server's default city either.
  for (const text of ['Will it rain in Lima?', 'is it going to rain in Atlantis tomorrow?',
    'what is the temperature in Lima today?']) {
    const query = parseWeatherQuery(text);
    assert.ok(query, text);
    assert.equal(query.location, '', text);
    assert.equal(query.hasOtherText, true, text);
  }
  // A known name is taken under a medium word as under a strong one.
  assert.equal(parseWeatherQuery('Will it rain in Paris?').location, 'Paris');
  assert.equal(parseWeatherQuery('is it hot in Taipei tomorrow').location, '臺北市');

  // A Taiwan name typed in English is still sent to the service as typed, so a deployment without
  // a CWA key keeps asking OpenWeather for it the way it always did.
  assert.equal(parseWeatherQuery('Hsinchu天氣').apiLocation, 'Hsinchu');
  assert.equal(parseWeatherQuery('Taipei weather tomorrow').apiLocation, 'Taipei');

  // English words that are not a place are not looked up: nothing is left of these sentences.
  for (const text of ['weather', 'how is the weather today', 'weather please', "what's the weather like", 'weather in the city']) {
    const query = parseWeatherQuery(text);
    assert.equal(query.location, '', text);
    assert.equal(query.ambiguous, null, text);
  }
  assert.equal(parseWeatherQuery('AI 可以查天氣嗎').location, '');
  assert.equal(parseWeatherQuery('Can AI tell me the weather').location, '');
  assert.equal(parseWeatherQuery('Discord 的天氣功能怎麼用').location, '');
  assert.equal(parseWeatherQuery(`${'a'.repeat(5000)} weather`).location, '', 'no city name is that long');
});

test('a bare weather word asks for a place; a weather word about a thing it cannot place asks too', () => {
  for (const text of ['天氣', '今天天氣如何', '天氣怎麼樣', '氣溫', '外面天氣如何', '今天天氣好嗎', '墾丁天氣', '台灣天氣']) {
    const query = parseWeatherQuery(text);
    assert.ok(query, text);
    assert.equal(query.location, '', text);
    assert.equal(query.ambiguous, null, text);
    assert.equal(query.invalid, null, text);
  }
  assert.equal(parseWeatherQuery('今天天氣如何').time, 'today');

  // A bare question has nothing else in it; a question about something this code cannot place has.
  for (const text of ['天氣', '今天會下雨嗎', '請問外面現在天氣怎麼樣呢', '小吉今天天氣還好嗎', 'what is the weather like']) {
    assert.equal(parseWeatherQuery(text).hasOtherText, false, text);
  }
  for (const text of ['墾丁天氣', '今天爬山會下雨嗎', 'Discord 的天氣功能怎麼用']) {
    assert.equal(parseWeatherQuery(text).hasOtherText, true, text);
  }
});

test('a strong word is a question alone; a medium word needs a place or a question tone', () => {
  // Strong words.
  for (const word of ['天氣', '氣象', '氣溫', '溫度', '降雨機率', '下雨機率', 'weather', 'forecast']) {
    const query = parseWeatherQuery(`台北${word}`);
    assert.ok(query, word);
    assert.equal(query.location, '臺北市', word);
    assert.ok(parseWeatherQuery(word), `${word} alone`);
    assert.equal(detectWeatherIntent(word), true, word);
  }
  // Medium words with a place in the sentence.
  for (const word of ['下雨', '降雨', '會不會下雨', '要不要帶傘', '帶傘', '雨傘', '幾度', '冷不冷', '熱不熱', '會冷', '會熱', 'rain', 'umbrella', 'temperature']) {
    const query = parseWeatherQuery(`台北${word}`);
    assert.ok(query, word);
    assert.equal(query.location, '臺北市', word);
  }
  // Medium words with a question tone and no place: a question, asking for the place.
  for (const text of ['今天會下雨嗎', '會下雨呢', '明天會下雨？', '會不會下雨', '要不要帶傘', '有沒有下雨', '今天冷不冷', '現在幾度', '明天會熱嗎', 'will it rain tomorrow?']) {
    const query = parseWeatherQuery(text);
    assert.ok(query, text);
    assert.equal(query.location, '', text);
    assert.equal(query.ambiguous, null, text);
  }
  // A short question with some words of its own (the hour, an activity) still asks for the place.
  for (const text of ['今天下午三點會下雨嗎', '今天爬山會下雨嗎']) {
    const query = parseWeatherQuery(text);
    assert.ok(query, text);
    assert.equal(query.location, '', text);
  }
  // Medium words with neither: chat.
  for (const text of ['下雨了好煩', '今天一直下雨', '帶傘出門', '雨傘壞了', '我會冷', 'rain is nice', '今天好冷喔', '好熱']) {
    assert.equal(parseWeatherQuery(text), null, text);
  }
  // The same word about a thing and not the weather.
  assert.equal(parseWeatherQuery('這樣不會冷場嗎'), null);
  assert.equal(parseWeatherQuery('這裡會熱鬧嗎'), null);
  assert.equal(parseWeatherQuery('你知道雨傘節是什麼嗎'), null);
  assert.equal(parseWeatherQuery('下雨天要不要出門'), null);
  assert.equal(parseWeatherQuery('今天下雨天'), null);
});

test('chat that only sounds like the weather is not a weather question', () => {
  const chat = [
    '你好', '今天心情不錯', '下雨天心情不好', '我今天好熱', '台北好玩嗎', '我想去東京玩', '你喜歡下雨天嗎',
    '你喜歡下雨嗎', '為什麼會下雨', '推薦台北的美食', '高雄有什麼好吃的', '明天要上班好煩', '週末有什麼活動',
    '這週末要不要一起玩遊戲', '現在幾點', '你會不會唱歌', '我在台北工作', '東京鐵塔有多高', '大阪燒怎麼做',
    '今天要不要玩猜數字', '傘好像壞掉了', '溫泉好舒服', '這杯咖啡好熱', '這杯咖啡熱不熱', '你冷不冷', '氣球好漂亮',
    '氣氛很棒', '我會冷靜下來的', '我想買一把傘', '下雨的時候你會做什麼', '星期六日要加班嗎', '台北今天好熱喔',
    '高雄明天好冷', '今天晚餐吃什麼', '台中的夜市有什麼好吃的', 'How are you today', 'I love Tokyo',
    'What time is it in London', 'rain rain go away', 'I like the rain', 'do you like rain?', 'why does it rain?',
    'Tell me a joke', 'https://example.com/weather', '<@123456789012345678> 你好', '', '   ', '？？', '😀',
    // A story that has 下雨 and a 嗎 in it, and no place to look up.
    '我昨天去爬山遇到下雨，全身都濕了，你有類似的經驗嗎',
    // A degree, or a cold or hot, of something that is not the weather. These were taken for weather
    // questions (and answered for the server's default city) when a 嗎 or a ？ was enough.
    '你會冷嗎', '冷氣要開幾度比較省電？', '發燒幾度要看醫生？', '烤箱要預熱幾度？', '洗澡水幾度比較好？',
    '你們家冷氣開幾度？', '他會熱舞嗎', '你會冷笑話嗎', '他會冷處理嗎', '我的手機會熱是正常的嗎', '筆電玩遊戲會熱嗎',
    'what is the temperature of boiling water?', '三角形內角和是幾度？', '直角是幾度？', '牛排要煎到幾度？',
    '冰箱冷凍庫要設幾度？', '咖啡要幾度才好喝？', '這題答案是幾度？', '要轉幾度？', '酒精濃度幾度？',
    '便當放到中午會冷掉嗎', '這件外套穿了會熱嗎',
    // The same with a time word in it, but about a thing and not the weather.
    '現在冷氣要開幾度比較省電？', '今天發燒幾度要看醫生？', '今天水溫幾度', '你有雨傘嗎', '你有沒有雨傘',
    '你今天有帶傘嗎', '你有沒有帶傘', '今天火鍋會很熱嗎', '明天便當會冷掉嗎', '今天會冷場嗎', 'Is it cold in here?',
    // A forecast of something else, a car or a house that has a wiper or an awning, and 冷嗎 or 熱嗎
    // asked of a person or a thing with only a time word to stand for a place.
    '今天股市預報怎樣', '地震預報準嗎', '這部電影的票房預報出來了', '你的車有雨刷嗎', '這台車有雨刷嗎', '門口有雨棚嗎',
    '有雨量計嗎', '你今天冷嗎', '今天水冷嗎', '今天你熱嗎',
    // A plain statement about a day that is gone.
    '昨天台北下雨了', '昨天下雨我沒帶傘結果淋濕了', '上週末在高雄下了很久的雨',
  ];
  assert.ok(chat.length >= 30);
  for (const text of chat) {
    assert.equal(parseWeatherQuery(text), null, JSON.stringify(text));
  }
  // Not a question: the old reading took 下雨 and 溫度 anywhere in the sentence.
  assert.equal(detectWeatherIntent('你好'), false);
  // Anything that is not text is not a question either.
  for (const value of [null, undefined, 0, {}, []]) assert.equal(parseWeatherQuery(value), null);
});

test('a word about heat or cold, or a degree, is a weather question with a place or with a question and a time', () => {
  // With a place in the sentence.
  for (const text of ['台北幾度', '高雄現在幾度', '台北明天熱嗎', '台北明天冷嗎', '台北明天會很冷嗎', '台北多少度',
    '台北明天會熱嗎', '台北冷不冷', 'Is it hot in Taipei tomorrow', 'will it be cold in Tokyo tomorrow?',
    'How cold is it in Seoul now?']) {
    const query = parseWeatherQuery(text);
    assert.ok(query, text);
    assert.notEqual(query.location, '', text);
  }
  // With a question and a time word, and no place: the place is asked for.
  for (const text of ['今天冷不冷', '現在幾度', '明天會熱嗎', '明天會很冷嗎', '今天多少度', '今晚會冷嗎',
    '後天熱不熱', 'is it hot tomorrow?', 'will it be cold tonight', "what's the temperature now?",
    // A question about the person asking is still a question about the weather when it says more.
    '你覺得明天會冷嗎', '明天是不是會冷']) {
    const query = parseWeatherQuery(text);
    assert.ok(query, text);
    assert.equal(query.location, '', text);
    assert.equal(query.ambiguous, null, text);
  }
  // Without a place or without a time word they are about something else.
  for (const text of ['你冷嗎', '這杯咖啡熱嗎', '多少度', '會很冷嗎', '幾度？', '今天你會冷', 'is it hot', 'it is hot today',
    'temperature', "what's the temperature?"]) {
    assert.equal(parseWeatherQuery(text), null, text);
  }
  // 冷嗎 and 熱嗎 are asked of a place. A time word is no place: 你今天冷嗎 asks a person, 今天水冷嗎 a
  // thing. Only a place, or a weather word of their own, makes them a weather question.
  for (const text of ['你今天冷嗎', '今天水冷嗎', '今天冷嗎', '明天冷嗎', '今天熱嗎', '你今天熱嗎', '今天你熱嗎', '明天這裡冷嗎',
    '你今天會冷嗎', '今天你會冷嗎']) {
    assert.equal(parseWeatherQuery(text), null, text);
  }
  assert.equal(parseWeatherQuery('台北今天冷嗎').location, '臺北市');
  assert.equal(parseWeatherQuery('明天高雄熱嗎').location, '高雄市');
  for (const [text, time] of [['今天天氣冷嗎', 'today'], ['明天天氣熱嗎', 'tomorrow']]) {
    const query = parseWeatherQuery(text);
    assert.ok(query, text);
    assert.equal(query.location, '', text);
    assert.equal(query.time, time, text);
  }
  // Another clause that is about a thing does not turn a question about the weather into one about it.
  assert.equal(parseWeatherQuery('明天會冷嗎，我要去咖啡店').time, 'tomorrow');
  assert.equal(parseWeatherQuery('明天會冷嗎，我要去咖啡店').hasOtherText, true);
  // 冷氣團 and 暖氣團 are weather, 冷氣 and 暖氣 are a machine.
  assert.equal(parseWeatherQuery('冷氣團來了明天會冷嗎').time, 'tomorrow');
  assert.equal(parseWeatherQuery('冷氣團來了明天會冷嗎').location, '');
  assert.equal(parseWeatherQuery('這波冷氣團明天台北會很冷嗎').location, '臺北市');
  assert.equal(parseWeatherQuery('這波冷氣團明天台北會很冷嗎').time, 'tomorrow');
  assert.equal(parseWeatherQuery('暖氣團來了明天會熱嗎').time, 'tomorrow');
  for (const text of ['冷氣明天會冷嗎', '暖氣明天會熱嗎', '冷氣要開幾度？', '今天暖氣要開幾度']) {
    assert.equal(parseWeatherQuery(text), null, text);
  }
  // A time word does not turn a degree of a thing into the weather.
  for (const text of ['現在冷氣要開幾度比較省電？', '今天發燒幾度要看醫生？', '今天水溫幾度', '明天烤箱要預熱幾度？']) {
    assert.equal(parseWeatherQuery(text), null, text);
  }
  // A word about rain needs only a place or a question.
  assert.equal(parseWeatherQuery('有雨嗎').location, '');
  assert.equal(parseWeatherQuery('今天有雨嗎').location, '');
  assert.equal(parseWeatherQuery('台北明天有雨嗎').location, '臺北市');
  assert.equal(parseWeatherQuery('你有雨傘嗎'), null);
  assert.equal(parseWeatherQuery('今天帶雨傘嗎').location, '');
  // 有雨 followed by a thing is a car or a house that has it, not rain.
  for (const text of ['你的車有雨刷嗎', '這台車有雨刷嗎', '門口有雨棚嗎', '有雨量計嗎', '有雨衣嗎', '你有雨鞋嗎', '包包有雨罩嗎']) {
    assert.equal(parseWeatherQuery(text), null, text);
  }
});

test('預報 alone is not a weather question; it needs a weather word or a place', () => {
  // A forecast of the stock market, an earthquake or a box office has no weather in it.
  for (const text of ['今天股市預報怎樣', '地震預報準嗎', '這部電影的票房預報出來了', '股市預報', '預報', '預报', '今天預報',
    '明天預報', '颱風預報']) {
    assert.equal(parseWeatherQuery(text), null, text);
    assert.equal(isWeatherQuery(text), false, text);
  }
  // With a place it is the forecast of that place.
  for (const [text, location, time] of [['台北預報', '臺北市', 'today'], ['台北明天預報', '臺北市', 'tomorrow'],
    ['高雄預報', '高雄市', 'today'], ['东京预报', 'Tokyo', 'today']]) {
    const query = parseWeatherQuery(text);
    assert.ok(query, text);
    assert.equal(query.location, location, text);
    assert.equal(query.time, time, text);
  }
  // 天氣預報 and 氣象預報 hold a weather word of their own.
  for (const text of ['天氣預報', '氣象預報', '今天天氣預報怎麼樣', '天气预报', '預報天氣']) {
    const query = parseWeatherQuery(text);
    assert.ok(query, text);
    assert.equal(query.location, '', text);
  }
  assert.equal(parseWeatherQuery('台北氣象預報').location, '臺北市');
  assert.equal(parseWeatherQuery('台北天氣預報').location, '臺北市');
});

test('the next weekend is the week, never this weekend', () => {
  for (const text of ['下週末台中天氣', '下個週末台中天氣', '下周末台中天氣', '下個周末台中天氣', '台中下週末會下雨嗎',
    '下週六日台中天氣', '下個禮拜六日台中天氣', 'Taichung weather next weekend']) {
    const query = parseWeatherQuery(text);
    assert.equal(query.time, 'week', text);
    assert.equal(query.location, '臺中市', text);
    assert.equal(query.unsupportedTime, null, text);
  }
  // This weekend is still this weekend, with or without the word before it.
  for (const text of ['這週末台中天氣', '本週末台中天氣', '週末台中天氣', '這個週末台中天氣', '這週六日台中天氣',
    '這個禮拜六日台中天氣', 'Taichung weather this weekend']) {
    assert.equal(parseWeatherQuery(text).time, 'weekend', text);
  }
});

test('a day that is gone, or too far away, is told so and is never answered with today', () => {
  const past = ['昨天台北有下雨嗎', '昨天台北天氣', '前天高雄天氣如何', '昨晚台北會下雨嗎', '上週台中天氣很好', '上個月台北天氣',
    '去年台北天氣', '上週末台中天氣', '上個禮拜台北有下雨嗎', '前幾天台北天氣', '昨天幾度', 'Taipei weather yesterday',
    'what was the weather in Taipei last week', 'did it rain in Taipei last night?',
    '三天前台北天氣', '一週前台北天氣', '兩個月前台北有下雨嗎', '2 days ago Taipei weather'];
  for (const text of past) {
    const query = parseWeatherQuery(text);
    assert.ok(query, text);
    assert.equal(query.unsupportedTime, 'past', text);
  }
  const far = ['下個月東京天氣', '下個月台北會下雨嗎', '明年台北天氣', '下下週台北天氣', 'Tokyo weather next month',
    '下半年台北天氣', '這個月天氣', '本月台北天氣如何', '十天後台北天氣', '兩週後台北天氣', '一個月後東京天氣', 'Taipei weather in 2 weeks'];
  for (const text of far) {
    const query = parseWeatherQuery(text);
    assert.ok(query, text);
    assert.equal(query.unsupportedTime, 'far', text);
  }
  // Days counted from today that the forecast does cover are the week.
  for (const text of ['三天後台北天氣', '六天後台北會下雨嗎', 'Taipei weather in 3 days']) {
    const query = parseWeatherQuery(text);
    assert.equal(query.time, 'week', text);
    assert.equal(query.unsupportedTime, null, text);
  }
  // A day that can be answered wins when the sentence names one too.
  assert.equal(parseWeatherQuery('昨天沒下雨，今天會下雨嗎').unsupportedTime, null);
  assert.equal(parseWeatherQuery('昨天沒下雨，今天會下雨嗎').time, 'today');
  assert.equal(parseWeatherQuery('昨天台北天氣很好，明天呢，天氣如何').time, 'tomorrow');
  // A plain statement about a day that is gone, without a question and without a weather word of
  // its own, is chat.
  for (const text of ['昨天台北下雨了', '昨天下雨我沒帶傘結果淋濕了', '上週台北下雨了好幾天', '去年冬天台北很冷']) {
    assert.equal(parseWeatherQuery(text), null, text);
  }
  // Today and the days after it have no such mark.
  for (const text of ['台北今天天氣', '台北明天天氣', '台北後天天氣', '台北這週天氣', '台北下週天氣']) {
    assert.equal(parseWeatherQuery(text).unsupportedTime, null, text);
  }
});

test('a word that holds a time word by accident names no time', () => {
  // 清明天氣 holds 明天, 目前天氣 holds 前天, 然後天氣 holds 後天, 如今天氣 holds 今天.
  const cases = [
    ['清明天氣如何', 'today'], ['清明天氣怎麼樣', 'today'], ['台北清明天氣', 'today'],
    ['目前天氣如何', 'today'], ['以前天氣比較冷嗎', 'today'], ['之前天氣如何', 'today'],
    ['然後天氣怎麼樣', 'today'], ['之後天氣會變冷嗎', 'today'], ['以後天氣如何', 'today'], ['最後天氣怎樣', 'today'],
    ['如今天氣如何', 'today'], ['至今天氣如何', 'today'],
    // Any "...後" or "...前" in front of 天氣 holds 後天 or 前天.
    ['颱風過後天氣如何', 'today'], ['雨後天氣怎麼樣', 'today'], ['節前天氣如何', 'today'], ['放假前天氣如何', 'today'],
    ['出發前天氣如何', 'today'],
  ];
  for (const [text, time] of cases) {
    const query = parseWeatherQuery(text);
    assert.ok(query, text);
    assert.equal(query.time, time, text);
    assert.equal(query.unsupportedTime, null, text);
  }
  // 明天氣如何 is the common typo of 明天天氣如何: with nothing in front of it, it is the day. The same
  // letters after a character that belongs to another word ("過後天氣", "節前天氣") are no day.
  for (const [text, time, location] of [
    ['明天氣如何', 'tomorrow', ''], ['明天氣怎麼樣', 'tomorrow', ''], ['後天氣如何', 'day_after_tomorrow', ''],
    ['後天氣怎樣', 'day_after_tomorrow', ''], ['台北後天氣如何', 'day_after_tomorrow', '臺北市'],
    ['請問後天氣如何', 'day_after_tomorrow', ''], ['請問明天氣如何', 'tomorrow', ''],
    ['高雄明天氣如何', 'tomorrow', '高雄市'], ['我想知道後天氣如何', 'day_after_tomorrow', ''],
    ['颱風過後天氣如何', 'today', ''], ['節前天氣如何', 'today', ''], ['過後天氣怎麼樣', 'today', '']]) {
    const query = parseWeatherQuery(text);
    assert.ok(query, text);
    assert.equal(query.time, time, text);
    assert.equal(query.location, location, text);
    assert.equal(query.unsupportedTime, null, text);
  }
  assert.equal(parseWeatherQuery('前天氣如何').unsupportedTime, 'past');
  // The real words are still read.
  assert.equal(parseWeatherQuery('明天氣溫幾度').time, 'tomorrow');
  assert.equal(parseWeatherQuery('今天氣溫幾度').time, 'today');
  assert.equal(parseWeatherQuery('後天氣象如何').time, 'day_after_tomorrow');
  assert.equal(parseWeatherQuery('後天氣溫多少').time, 'day_after_tomorrow');
  assert.equal(parseWeatherQuery('明天氣象如何').time, 'tomorrow');
  assert.equal(parseWeatherQuery('前天氣溫多少').unsupportedTime, 'past');
  assert.equal(parseWeatherQuery('他說明天會下雨嗎').time, 'tomorrow');
  assert.equal(parseWeatherQuery('查明天天氣').time, 'tomorrow');
  assert.equal(parseWeatherQuery('前天台北天氣').unsupportedTime, 'past');
  // A time word in front of a place never swallows the first characters of the place.
  for (const [text, location, unsupported] of [
    ['下月台北天氣', '臺北市', 'far'], ['上月台北天氣', '臺北市', 'past'], ['昨天台北天氣', '臺北市', 'past'],
    ['前天台中天氣', '臺中市', 'past'], ['目前台北天氣', '臺北市', null], ['現在台南天氣', '臺南市', null],
    ['清明節台北天氣', '臺北市', null], ['下週末新竹市天氣', '新竹市', null]]) {
    const query = parseWeatherQuery(text);
    assert.equal(query.location, location, text);
    assert.equal(query.unsupportedTime, unsupported, text);
  }
  assert.equal(parseWeatherQuery('目前台北天氣').time, 'today');
});

test('a district whose name is an everyday word is a place only with its county or its suffix', () => {
  const everyday = ['暖暖', '成功', '中山', '公館', '關西', '和平', '中正', '太平', '光復', '大同', '仁愛', '復興', '長治'];
  for (const stem of everyday) {
    // Written alone it is a word of the sentence, and the sentence asks for a place.
    for (const text of [`${stem}天氣`, `${stem}明天天氣如何`, `${stem}今天會下雨嗎`]) {
      const query = parseWeatherQuery(text);
      assert.ok(query, text);
      assert.equal(query.location, '', text);
      assert.equal(query.ambiguous, null, text);
      assert.equal(query.hasOtherText, true, `${text}: not for the server's default city`);
    }
    // Written with its county, or with its 區 鄉 鎮 市, it is the district.
    const entries = TAIWAN_DISTRICTS.filter((entry) => entry.district.startsWith(stem)
      && /[區鄉鎮市]$/u.test(entry.district) && entry.district.length === 3);
    assert.ok(entries.length >= 1, stem);
    for (const entry of entries) {
      const withCounty = parseWeatherQuery(`${entry.county.replace('臺', '台')}${stem}天氣`);
      assert.equal(withCounty.location, `${entry.county}${entry.district}`, stem);
      const withSuffix = parseWeatherQuery(`${entry.district}天氣`);
      assert.ok(withSuffix.location === `${entry.county}${entry.district}` || withSuffix.ambiguous, entry.district);
    }
  }
  // 暖暖的天氣 is the warm weather.
  assert.equal(parseWeatherQuery('暖暖的天氣真舒服').location, '');
  assert.equal(parseWeatherQuery('暖暖區天氣').location, '基隆市暖暖區');
  assert.equal(parseWeatherQuery('基隆暖暖天氣').location, '基隆市暖暖區');
  // The places that people do ask for by their short name are still places.
  for (const [text, location] of [['新莊天氣', '新北市新莊區'], ['板橋天氣', '新北市板橋區'], ['淡水天氣', '新北市淡水區'],
    ['阿里山天氣', '嘉義縣阿里山鄉'], ['北投天氣', '臺北市北投區'], ['信義區天氣', null]]) {
    const query = parseWeatherQuery(text);
    if (location === null) assert.ok(query.ambiguous, text);
    else assert.equal(query.location, location, text);
  }
  // The slash command reads a place strictly, so it still takes the short name.
  assert.equal(normalizeWeatherCommandLocation('成功').city, '臺東縣');
  assert.equal(normalizeWeatherCommandLocation('暖暖').location, '基隆市暖暖區');
});

test('a real district written under a county that does not have it is a wrong district, never the county', () => {
  // The five sentences a member really typed: the county is right, the district belongs to another.
  for (const text of ['台北樹林區天氣', '台北土城區明天天氣', '台北泰山區明天天氣', '台中鳳山區天氣', '台北板橋區天氣']) {
    const query = parseWeatherQuery(text);
    assert.ok(query, text);
    assert.ok(query.invalid, text);
    assert.equal(query.apiLocation, '', text);
    assert.ok(!query.city && !query.district, `${text}: the county is not read for it`);
  }

  // Real district names end in the same words as an area that is no district (園區, 山區, 林區, 港區,
  // 市區...). All of them, under a county that has none of that name, are told apart from those.
  const generic = ['園區', '社區', '校區', '景區', '林區', '山區', '港區', '廠區', '特區', '災區', '商區', '住宅區',
    '工業區', '商業區', '管制區', '保護區', '禁區', '疫區', '分區', '地區', '城區', '市區', '郊區'];
  const ownersOf = new Map();
  for (const { county, district } of TAIWAN_DISTRICTS) {
    if (!generic.some((suffix) => district.endsWith(suffix))) continue;
    if (!ownersOf.has(district)) ownersOf.set(district, new Set());
    ownersOf.get(district).add(county);
  }
  assert.ok(ownersOf.size >= 27, `${ownersOf.size} district names end like an area word`);
  for (const name of ['樹林區', '土城區', '泰山區', '金山區', '坪林區', '松山區', '中山區', '鳳山區', '桃園區', '大園區', '香山區']) {
    assert.ok(ownersOf.has(name), name);
  }

  const spoken = (county) => county.replace('臺', '台').replace(/[市縣]$/u, '');
  const wrongCounties = ['臺北市', '臺中市', '高雄市', '新北市', '桃園市', '臺南市', '花蓮縣', '宜蘭縣'];
  let wrongReadings = 0;
  let rightReadings = 0;
  for (const [district, owners] of ownersOf) {
    const wrong = wrongCounties.filter((county) => !owners.has(county));
    assert.ok(wrong.length >= 6, district);
    for (const county of wrong) {
      for (const text of [`${spoken(county)}${district}天氣`, `${spoken(county)}${district}明天天氣`,
        `明天${spoken(county)}${district}會下雨嗎`, `${county}${district}今天天氣`]) {
        const query = parseWeatherQuery(text);
        assert.ok(query, text);
        assert.ok(query.invalid, text);
        assert.equal(query.apiLocation, '', text);
        assert.ok(!query.city && !query.district, text);
        wrongReadings += 1;
      }
    }
    // With the county that has it, spoken short or written in full, it is that district.
    for (const county of owners) {
      const names = county === '新竹市' ? [county] : [spoken(county), county];
      for (const countyName of names) {
        for (const text of [`${countyName}${district}天氣`, `明天${countyName}${district}會下雨嗎`]) {
          const query = parseWeatherQuery(text);
          assert.equal(query.location, `${county}${district}`, text);
          assert.equal(query.invalid, null, text);
          assert.equal(query.ambiguous, null, text);
          rightReadings += 1;
        }
      }
    }
  }
  assert.ok(wrongReadings >= 27 * 6 * 4, `${wrongReadings} wrong readings`);
  assert.ok(rightReadings >= 28 * 2, `${rightReadings} right readings`);

  // A word that is no district at all (a park, a zone, a harbour area) is still read as the county.
  for (const [text, location] of [['高雄港區天氣', '高雄市'], ['台中工業區天氣', '臺中市'], ['台北社區天氣', '臺北市'],
    ['台北山區天氣', '臺北市'], ['台北科技園區天氣', '臺北市'], ['台北市區天氣', '臺北市'], ['新北林區天氣', '新北市']]) {
    const query = parseWeatherQuery(text);
    assert.equal(query.location, location, text);
    assert.equal(query.invalid, null, text);
  }
  // The strict reading of the slash command tells the same wrong district.
  assert.ok(normalizeWeatherCommandLocation('台北樹林區').invalid);
  assert.equal(normalizeWeatherCommandLocation('新北樹林區').location, '新北市樹林區');
});

test('simplified Chinese and the other ways of asking are read as the traditional ones', () => {
  const cases = [
    ['台北明天天气怎么样', '臺北市', 'tomorrow'],
    ['北京天气', 'Beijing', 'today'],
    ['广州天气预报', 'Guangzhou', 'today'],
    ['上海今天气温多少', 'Shanghai', 'today'],
    ['东京明天会下雨吗', 'Tokyo', 'tomorrow'],
    ['高雄明天会不会下雨', '高雄市', 'tomorrow'],
    ['台中今天热不热', '臺中市', 'today'],
    ['台北这周末天气', '臺北市', 'weekend'],
    ['台北下周末天气', '臺北市', 'week'],
    ['台北现在几度', '臺北市', 'today'],
    ['后天花莲天气', '花蓮縣', 'day_after_tomorrow'],
    ['后里天气', '臺中市后里區', 'today'],
    ['新北市板桥区天气', '新北市板橋區', 'today'],
    ['台北天气预报', '臺北市', 'today'],
    ['台北的温度', '臺北市', 'today'],
    ['台北降雨概率', '臺北市', 'today'],
  ];
  for (const [text, location, time] of cases) {
    const query = parseWeatherQuery(text);
    assert.ok(query, text);
    assert.equal(query.location, location, text);
    assert.equal(query.time, time, text);
  }
  // The question markers.
  for (const text of ['明天会下雨吗', '会不会下雨', '要不要带伞', '今天冷不冷', '明天会热吗']) {
    const query = parseWeatherQuery(text);
    assert.ok(query, text);
    assert.equal(query.location, '', text);
  }
  // The weather words alone are a question, and with a place they name it. 预报 is a forecast of a
  // place and not a question without one (a stock market has its forecast too).
  for (const word of ['天气', '气象', '气温', '温度']) {
    assert.ok(parseWeatherQuery(word), word);
    assert.equal(parseWeatherQuery(`台北${word}`).location, '臺北市', word);
  }
  for (const word of ['预报', '預報']) {
    assert.equal(parseWeatherQuery(word), null, word);
    assert.equal(parseWeatherQuery(`台北${word}`).location, '臺北市', word);
  }
  // A district written in simplified characters is the district; under the wrong county it is wrong.
  for (const [text, location] of [['桃园天气', '桃園市'], ['桃园市中坜区天气', '桃園市中壢區'],
    ['新北树林区天气', '新北市樹林區'], ['高雄凤山区明天天气', '高雄市鳳山區'], ['高雄冈山天气', '高雄市岡山區'],
    ['三峡天气', '新北市三峽區'], ['台中后里区天气', '臺中市后里區']]) {
    assert.equal(parseWeatherQuery(text).location, location, text);
  }
  for (const text of ['台北树林区天气', '台中凤山区明天天气']) {
    assert.ok(parseWeatherQuery(text).invalid, text);
  }
  // Simplified chat is chat.
  for (const text of ['你会冷吗', '冷气要开几度', '这杯咖啡热吗']) {
    assert.equal(parseWeatherQuery(text), null, text);
  }
  // A simplified overseas name and a command city.
  assert.equal(normalizeWeatherCommandLocation('东京').location, 'Tokyo');
  assert.equal(normalizeWeatherCommandLocation('广州').location, 'Guangzhou');
  assert.equal(resolveOverseasCityName('纽约'), 'New York');
});

test('Discord markup, full-width letters and case do not change what is read', () => {
  const same = ['台北天氣', '<@123456789012345678> 台北天氣', '<@!123456789012345678> 台北天氣',
    '<@123456789012345678><@&223456789012345678> 台北 天氣', '　台北　天氣　', '台北天氣！！', '「台北」天氣？',
    '臺北天氣', '台北 ＷＥＡＴＨＥＲ', 'TAIPEI WEATHER', 'Taipei Weather', '<#323456789012345678> Taipei weather'];
  for (const text of same) {
    const query = parseWeatherQuery(text);
    assert.equal(query.location, '臺北市', text);
    assert.equal(query.time, 'today', text);
  }
  assert.equal(parseWeatherQuery('ＴＯＫＹＯ ｗｅａｔｈｅｒ').location, 'Tokyo');
  assert.equal(parseWeatherQuery('<@123456789012345678> 明天高雄會下雨嗎').location, '高雄市');
  assert.equal(parseWeatherQuery('<@123456789012345678>'), null);
  // 台 and 臺 are the same.
  assert.equal(parseWeatherQuery('台南天氣').location, parseWeatherQuery('臺南天氣').location);
  assert.equal(parseWeatherQuery('台東縣成功鎮天氣').location, '臺東縣成功鎮');
});

test('words around a place never break a county or district name', () => {
  // None of the filler, particle or time words occurs inside a Taiwan place name, so a name in a
  // sentence is read exactly as the name alone.
  const counties = [...new Set(TAIWAN_DISTRICTS.map((entry) => entry.county))];
  for (const county of counties) {
    const query = parseWeatherQuery(`請問明天${county.replace('臺', '台')}會下雨嗎`);
    assert.equal(query.location, county, county);
    assert.equal(query.time, 'tomorrow', county);
  }
  for (const { county, district } of TAIWAN_DISTRICTS) {
    const name = `${county}${district}`;
    for (const text of [`${name}天氣`, `我想知道${name.replace('臺', '台')}今天會不會下雨呢`, `明天${name}要帶傘嗎`]) {
      const query = parseWeatherQuery(text);
      assert.equal(query.location, name, text);
      assert.equal(query.city, county, text);
      assert.equal(query.district, district, text);
    }
    assert.equal(normalizeWeatherCommandLocation(name).location, name);
    assert.equal(cleanWeatherLocationText(name), name);
  }
});

test('the strict reading used by slash commands is unchanged', () => {
  assert.equal(normalizeWeatherCommandLocation('台北市大安區').location, '臺北市大安區');
  assert.equal(normalizeWeatherCommandLocation('新北新莊').location, '新北市新莊區');
  assert.equal(normalizeWeatherCommandLocation('Taipei').location, 'Taipei');
  assert.equal(normalizeWeatherCommandLocation('Hsinchu').location, 'Hsinchu');
  // A sentence is not a place for the strict reading: it keeps whatever it cannot remove.
  assert.equal(normalizeWeatherCommandLocation('高雄會嗎').invalid, '高雄會嗎');
});

// ---------------------------------------------------------------------------
// Reading stays linear
// ---------------------------------------------------------------------------

test('reading is linear: 2000 characters of noise and 5000 repeated 天氣 take a few milliseconds', () => {
  let seed = 20261012;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pieces = ['天氣', '台北', '新竹', '東區', '明天', '下雨', '會不會', 'weather', ' ', '，', '？', '區', '市', 'abc',
    String.fromCodePoint(0x4e00 + 37), '的', '嗎'];
  const noise = Array.from({ length: 2000 }, () => pieces[Math.floor(next() * pieces.length)]).join('').slice(0, 2000);
  const randomHan = Array.from({ length: 2000 }, () => String.fromCodePoint(0x4e00 + Math.floor(next() * 20000))).join('');
  const inputs = [
    ['2000 characters of noise', noise],
    ['2000 random characters and 天氣', `${randomHan}天氣`],
    ['5000 x 天氣', '天氣'.repeat(5000)],
    ['5000 x 天氣 with spaces', '天氣 '.repeat(5000)],
    ['3000 x 台北天氣', '台北天氣'.repeat(3000)],
    ['5000 x 新竹 then 天氣', `${'新竹'.repeat(5000)}天氣`],
    ['5000 x 下雨嗎', '下雨嗎'.repeat(5000)],
    ['2000 x weather in Tokyo', 'weather in Tokyo '.repeat(2000)],
    ['5000 English words', `${'abc '.repeat(5000)}weather`],
    ['20000 x 天氣', '天氣'.repeat(20000)],
    // Runs of the characters a counted day is made of ("三天前"), and the same counted day repeated.
    ['20000 x 一 then 天氣', `${'一'.repeat(20000)}天氣`],
    ['20000 digits then 天前', `${'1'.repeat(20000)}天前天氣`],
    ['10000 x 三天後', `${'三天後'.repeat(10000)}天氣`],
    ['20000 x 幾度', `${'幾度'.repeat(10000)}今天`],
    ['10000 x 會很冷嗎', `${'會很冷嗎'.repeat(5000)}台北`],
    ['10000 x 昨天 and 下個月', `${'昨天下個月'.repeat(4000)}天氣`],
  ];
  for (const [label, text] of inputs) {
    const durations = [];
    for (let run = 0; run < 3; run += 1) {
      const started = process.hrtime.bigint();
      parseWeatherQuery(text);
      durations.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    const best = Math.min(...durations);
    // A run takes a few milliseconds; a quadratic read of these would take seconds.
    assert.ok(best < 100, `${label}: ${best.toFixed(1)} ms`);
  }
});

// ---------------------------------------------------------------------------
// What the chat answers
// ---------------------------------------------------------------------------

test('a question names its day and place in the reply, and the reply never repeats what was typed', async () => {
  const days = forecastDays(7);
  await withProviders({ cwa: nationwideResponse(days) }, async (requests) => {
    const tomorrow = await getWeatherMentionReply('<@123456789012345678> 明天高雄會下雨嗎');
    assert.match(tomorrow, /^高雄市明天天氣：\n\n天氣狀況：陰短暫雨\n/u);
    assert.match(tomorrow, /降雨機率：21%/u);
    assert.ok(tomorrow.endsWith('\n中央氣象署預報'));

    const afterTomorrow = await getWeatherMentionReply('後天臺北天氣');
    assert.match(afterTomorrow, /^臺北市後天天氣：/u);

    const today = await getWeatherMentionReply('台北今天要帶傘嗎');
    assert.match(today, /^臺北市今天天氣：/u);
    assert.match(today, /降雨機率：20%/u);

    const week = await getWeatherMentionReply('桃園這禮拜天氣');
    assert.ok(week.startsWith('桃園市未來7日預報：\n'), week);
    assert.equal(week.split('\n').length, 1 + 7 + 1);

    // Only the CWA nationwide dataset is read (it may already be kept from an earlier test).
    assert.ok(requests.every((request) => request.host === CWA_HOST && request.dataset === 'F-D0047-091'));
    assert.ok(requests.length <= 1);
  });

  // Whatever is typed, the reply is a fixed sentence or the service's own data.
  await withProviders({ openWeather: { current: { status: 404 }, forecast: { status: 404 } } }, async () => {
    for (const text of ['Zzyzxville天氣', 'weather in Zzyzxville', '@everyone Zzyzxville weather', 'Zzyzxville的天氣 https://evil.example/x']) {
      assert.equal(await getWeatherMentionReply(text), CITY_NOT_FOUND_MESSAGE, text);
    }
    for (const text of ['墾丁天氣', '今天會下雨嗎', '@everyone 天氣']) {
      const reply = await getWeatherMentionReply(text);
      assert.match(reply, /^你想查哪裡的天氣呢？/u, text);
      assert.doesNotMatch(reply, /墾丁|everyone/u, text);
    }
    for (const text of ['新竹天氣', '臺北市不存在區天氣']) {
      const reply = await getWeatherMentionReply(text);
      assert.doesNotMatch(reply, /不存在區/u, text);
    }
  });
});

test('a Taiwan place typed in English is read from CWA with a key and from OpenWeather without one', async () => {
  await withProviders({ cwa: nationwideResponse(forecastDays(3)) }, async (requests) => {
    const reply = await getWeatherMentionReply('Taipei weather tomorrow');
    assert.match(reply, /^臺北市明天天氣：/u);
    assert.equal(requests.some((request) => request.host === OPENWEATHER_HOST), false);
  });
  await withProviders({ openWeather: { current: OPENWEATHER_CURRENT, forecast: openWeatherForecast(Date.now()) } }, async (requests) => {
    const reply = await getWeatherMentionReply('Taipei weather');
    assert.match(reply, /OpenWeather 即時天氣$/u);
    assert.deepEqual(requests.map((request) => [request.host, request.q]), [[OPENWEATHER_HOST, 'Taipei']]);
  });
});

test('an overseas city is read from OpenWeather under its English name', async () => {
  const from = Date.now();
  await withProviders({ openWeather: { current: OPENWEATHER_CURRENT, forecast: openWeatherForecast(from) } }, async (requests) => {
    const today = await getWeatherMentionReply('東京天氣');
    assert.match(today, /^Tokyo, JP今天天氣：\n\n天氣狀況：晴\n/u);
    assert.match(today, /\nOpenWeather 即時天氣$/u);

    const tomorrow = await getWeatherMentionReply('明天大阪會下雨嗎');
    assert.match(tomorrow, /^Tokyo, JP明天天氣：/u, 'the stand-in answers every city with Tokyo');
    assert.match(tomorrow, /\nOpenWeather 預報$/u);

    const week = await getWeatherMentionReply('weather in Seoul next week');
    assert.match(week, /^Tokyo, JP未來5日預報：\n/u);

    assert.deepEqual(requests.map((request) => [request.path.split('/').at(-1), request.q]), [
      ['weather', 'Tokyo'], ['forecast', 'Osaka'], ['forecast', 'Seoul'],
    ]);
  });

  // A city OpenWeather does not know is answered with the fixed sentence.
  await withProviders({ openWeather: { current: { status: 404 }, forecast: { status: 404 } } }, async () => {
    assert.equal(await getWeatherMentionReply('weather in Atlantis'), CITY_NOT_FOUND_MESSAGE);
  });
});

test('a question about a day that is gone or too far away is answered with one fixed sentence and no request', async () => {
  writeGuildConfig({ [GUILD]: { weatherDefaultCity: '臺中市' } });
  const pastReply = '我只能查今天以後的天氣預報，過去的天氣查不到。';
  const farReply = '天氣預報大約只涵蓋未來一週，更久以後的天氣目前查不到。';
  await withProviders({
    cwa: nationwideResponse(forecastDays(7)),
    openWeather: { current: OPENWEATHER_CURRENT, forecast: openWeatherForecast(Date.now()) },
  }, async (requests) => {
    const before = requests.length;
    for (const text of ['昨天台北有下雨嗎', '上週台中天氣', '去年東京天氣如何', '前天高雄天氣', '昨晚下雨嗎',
      'weather in Tokyo yesterday', '清明節前天台北天氣']) {
      assert.equal(await getWeatherMentionReply(text, { guildId: GUILD }), pastReply, text);
      assert.equal(await getWeatherMentionReply(text), pastReply, `${text} (no server)`);
    }
    for (const text of ['下個月東京天氣', '下個月台北會下雨嗎', '明年台北天氣', 'Tokyo weather next month']) {
      assert.equal(await getWeatherMentionReply(text, { guildId: GUILD }), farReply, text);
    }
    assert.equal(requests.length, before, 'no weather service was asked');

    // A plain statement about the past is left to the conversation, and the others are answered.
    assert.equal(await getWeatherMentionReply('昨天台北下雨了', { guildId: GUILD }), null);
    assert.match(await getWeatherMentionReply('清明天氣如何', { guildId: GUILD }), /^臺中市今天天氣：/u);
    assert.match(await getWeatherMentionReply('台北下週末天氣'), /^臺北市未來7日預報：/u);
  });
});

test('a district under the wrong county is answered with one fixed sentence and no request', async () => {
  writeGuildConfig({ [GUILD]: { weatherDefaultCity: '臺中市' } });
  const wrongDistrictReply = '找不到這個行政區，請輸入完整且正確的縣市與行政區名稱。';
  await withProviders({
    cwa: nationwideResponse(forecastDays(7)),
    openWeather: { current: OPENWEATHER_CURRENT, forecast: openWeatherForecast(Date.now()) },
  }, async (requests) => {
    for (const text of ['台北樹林區天氣', '台北土城區明天天氣', '台北泰山區明天天氣', '台中鳳山區天氣', '台北板橋區天氣',
      '台北树林区天气']) {
      assert.equal(await getWeatherMentionReply(text, { guildId: GUILD }), wrongDistrictReply, text);
      assert.equal(await getWeatherMentionReply(text), wrongDistrictReply, `${text} (no server)`);
    }
    assert.equal(requests.length, 0, 'no weather service was asked');
  });
});

test('chat that mentions a degree or a cold is never answered for the server default city', async () => {
  writeGuildConfig({ [GUILD]: { weatherDefaultCity: '臺中市' } });
  const sentences = ['你會冷嗎', '冷氣要開幾度比較省電？', '發燒幾度要看醫生？', '烤箱要預熱幾度？', '洗澡水幾度比較好？',
    '你們家冷氣開幾度？', '他會熱舞嗎', '你會冷笑話嗎', '他會冷處理嗎', '我的手機會熱是正常的嗎', '筆電玩遊戲會熱嗎',
    'what is the temperature of boiling water?', '三角形內角和是幾度？', '直角是幾度？', '牛排要煎到幾度？',
    '冰箱冷凍庫要設幾度？', '咖啡要幾度才好喝？', '這題答案是幾度？', '要轉幾度？', '酒精濃度幾度？',
    '便當放到中午會冷掉嗎', '這件外套穿了會熱嗎'];
  assert.equal(sentences.length, 22);
  await withProviders({
    cwa: nationwideResponse(forecastDays(7)),
    openWeather: { current: OPENWEATHER_CURRENT, forecast: openWeatherForecast(Date.now()) },
  }, async (requests) => {
    const before = requests.length;
    for (const text of sentences) {
      assert.equal(await getWeatherMentionReply(text, { guildId: GUILD }), null, text);
      assert.equal(isWeatherQuery(text), false, text);
    }
    // A forecast of something else, a car with a wiper, and a cold asked of a person or a thing.
    for (const text of ['今天股市預報怎樣', '地震預報準嗎', '這部電影的票房預報出來了', '你的車有雨刷嗎', '這台車有雨刷嗎',
      '門口有雨棚嗎', '有雨量計嗎', '你今天冷嗎', '今天水冷嗎']) {
      assert.equal(await getWeatherMentionReply(text, { guildId: GUILD }), null, text);
      assert.equal(isWeatherQuery(text), false, text);
    }
    assert.equal(requests.length, before, 'not a single weather request was made');

    // Real weather questions with the same words are still answered.
    assert.match(await getWeatherMentionReply('台北現在幾度', { guildId: GUILD }), /^臺北市今天天氣：/u);
    assert.match(await getWeatherMentionReply('明天會熱嗎', { guildId: GUILD }), /^臺中市明天天氣：/u);
    assert.match(await getWeatherMentionReply('台北明天冷嗎', { guildId: GUILD }), /^臺北市明天天氣：/u);
  });
});

test('a question without a place uses the server default city and otherwise asks for a place', async (t) => {
  const prompt = '你想查哪裡的天氣呢？例如：臺北市大同區天氣、新北新莊天氣、臺南東區天氣。';
  writeGuildConfig({
    [GUILD]: { weatherDefaultCity: '  臺中市  ' },
    [OTHER_GUILD]: { weatherDefaultCity: '新竹' },
  });
  await withProviders({ cwa: nationwideResponse(forecastDays(3)) }, async (requests) => {
    // The server's default city answers any question that names no place.
    for (const text of ['今天會下雨嗎', '天氣', '今天天氣如何', '明天要帶傘嗎']) {
      const reply = await getWeatherMentionReply(text, { guildId: GUILD });
      assert.match(reply, /^臺中市(今天|明天)天氣：/u, text);
    }
    // Remarks and greetings around the question do not stop it.
    for (const text of ['今天好熱會下雨嗎', '小吉今天天氣如何', '你好 今天天氣還好嗎', '請問外面現在在下雨嗎']) {
      assert.match(await getWeatherMentionReply(text, { guildId: GUILD }), /^臺中市今天天氣：/u, text);
    }
    // A place in the sentence wins over the default.
    assert.match(await getWeatherMentionReply('高雄今天會下雨嗎', { guildId: GUILD }), /^高雄市今天天氣：/u);

    // A question about something that is no place this reading knows is not answered for another
    // city. Neither is a sentence that has other words of its own.
    const requestsBefore = requests.length;
    for (const text of ['墾丁天氣', '今天爬山會下雨嗎', 'Discord 的天氣功能怎麼用']) {
      assert.equal(await getWeatherMentionReply(text, { guildId: GUILD }), prompt, text);
    }
    assert.equal(requests.length, requestsBefore);

    // Without a server, with a server that has no default, and with a default that is ambiguous.
    assert.equal(await getWeatherMentionReply('今天會下雨嗎'), prompt);
    assert.equal(await getWeatherMentionReply('今天會下雨嗎', {}), prompt);
    assert.equal(await getWeatherMentionReply('今天會下雨嗎', { guildId: null }), prompt);
    assert.equal(await getWeatherMentionReply('今天會下雨嗎', { guildId: '900000000000000099' }), prompt);
    assert.equal(await getWeatherMentionReply('今天會下雨嗎', { guildId: OTHER_GUILD }), prompt);
    assert.equal(requests.length, requestsBefore, 'no request was made for these');
  });

  // The default city goes through the same reading as /weather: an English or Chinese overseas city.
  writeGuildConfig({ [GUILD]: { weatherDefaultCity: '東京' } });
  await withProviders({ openWeather: { current: OPENWEATHER_CURRENT, forecast: openWeatherForecast(Date.now()) } }, async (requests) => {
    const reply = await getWeatherMentionReply('今天會下雨嗎', { guildId: GUILD });
    assert.match(reply, /^Tokyo, JP今天天氣：/u);
    assert.deepEqual(requests.map((request) => request.q), ['Tokyo']);
    // An explicit place wins.
    await getWeatherMentionReply('大阪會下雨嗎', { guildId: GUILD });
    assert.deepEqual(requests.map((request) => request.q), ['Tokyo', 'Osaka']);
  });

  // A server setting that cannot be read is no reason to fail the chat: the question is asked back.
  fs.writeFileSync(guildConfigFile, '{ not json', 'utf8');
  assert.equal(await getWeatherMentionReply('今天會下雨嗎', { guildId: GUILD }), prompt);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  t.mock.method(guildConfig, 'getGuildConfig', () => { throw new Error('settings store failed https://evil.example/x'); });
  try {
    assert.equal(await getWeatherMentionReply('今天會下雨嗎', { guildId: GUILD }), prompt);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /weather default city unreadable: Error$/u);
  assert.doesNotMatch(warnings[0], /evil\.example/u);
});

test('the chat flow hands the server to the weather port, and a port that reads only the text still works', async (t) => {
  clearConversationStateForTests();
  t.after(() => clearConversationStateForTests());

  const seen = [];
  let sequence = 0;
  const send = async (content, guildId, weatherPort) => {
    sequence += 1;
    const replies = [];
    await handleMentionMessage({
      id: `weather-chat-port-${sequence}`,
      content: `<@999999999999999999> ${content}`,
      author: { id: `weather-chat-user-${sequence}`, username: '測試者', tag: '測試者', bot: false },
      client: { user: { id: '999999999999999999' } },
      guildId,
      channelId: `weather-chat-channel-${sequence}`,
      channel: {},
      createdTimestamp: Date.parse('2026-10-12T00:00:00.000Z'),
      async reply(payload) { replies.push(payload.content); },
    }, {
      generateChatReplyImpl: async () => '不應呼叫一般聊天提供者。',
      weatherPort,
      statusPort: { async recordInteraction() {} },
    });
    return replies;
  };

  const spyingPort = {
    isQuery: () => true,
    async getMentionReply(userText, context) {
      seen.push([userText, context]);
      return '臺北市今天天氣：晴。';
    },
  };
  assert.match((await send('今天會下雨嗎', GUILD, spyingPort))[0], /臺北市今天天氣：晴。/u);
  assert.match((await send('今天會下雨嗎', null, spyingPort))[0], /臺北市今天天氣：晴。/u);
  assert.deepEqual(seen, [
    ['今天會下雨嗎', { guildId: GUILD }],
    ['今天會下雨嗎', { guildId: null }],
  ]);

  const textOnlyPort = {
    isQuery: () => true,
    async getMentionReply(userText) {
      assert.equal(arguments.length, 2, 'the context is passed as a second argument');
      return `只讀文字：${userText.length}`;
    },
  };
  assert.match((await send('今天會下雨嗎', GUILD, textOnlyPort))[0], /只讀文字：6/u);

  // The real port, for a server with a default city.
  writeGuildConfig({ [GUILD]: { weatherDefaultCity: '臺中市' } });
  await withProviders({ cwa: nationwideResponse(forecastDays(3)) }, async () => {
    const replies = await send('今天會下雨嗎', GUILD, createConversationPorts().weatherPort);
    assert.match(replies[0], /臺中市今天天氣：/u);
  });
});

// ---------------------------------------------------------------------------
// The weekend
// ---------------------------------------------------------------------------

// Taiwan wall-clock to the instant, for mocking the clock.
function taipei(dateTime) {
  return Date.parse(`${dateTime.replace(' ', 'T')}:00+08:00`);
}

test('the weekend days are this week\'s Saturday and Sunday, and only those that have not passed', () => {
  const cases = [
    ['2026-10-12 00:00', ['2026-10-17', '2026-10-18']], // Monday
    ['2026-10-14 10:00', ['2026-10-17', '2026-10-18']], // Wednesday
    ['2026-10-16 23:59', ['2026-10-17', '2026-10-18']], // Friday
    ['2026-10-17 00:00', ['2026-10-17', '2026-10-18']], // Saturday
    ['2026-10-17 23:59', ['2026-10-17', '2026-10-18']],
    ['2026-10-18 00:00', ['2026-10-18']], // Sunday: Saturday has passed
    ['2026-10-18 23:59', ['2026-10-18']],
    ['2026-10-19 00:00', ['2026-10-24', '2026-10-25']], // Monday again: the next weekend
  ];
  for (const [wallClock, expected] of cases) {
    assert.deepEqual(weekendDayKeys(new Date(taipei(wallClock))), expected, wallClock);
    assert.deepEqual(expectedWeekend(taipei(wallClock)), expected, `${wallClock} (the test's own count)`);
  }
  // Taiwan's date decides, not UTC's: Friday 17:00 UTC is already Saturday 01:00 in Taipei.
  assert.deepEqual(weekendDayKeys(new Date('2026-10-16T17:00:00Z')), ['2026-10-17', '2026-10-18']);
  assert.deepEqual(weekendDayKeys(new Date('2026-10-18T15:59:00Z')), ['2026-10-18']);
  assert.deepEqual(weekendDayKeys(new Date('2026-10-18T16:00:00Z')), ['2026-10-24', '2026-10-25']);
});

test('CWA: a weekend question lists Saturday and Sunday, not today', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: taipei('2026-10-14 10:00') }); // Wednesday
  const days = forecastDays(7, Date.now());
  await withProviders({ cwa: districtResponse('臺中市', '西區', '66000040', days) }, async () => {
    const weekend = await getWeather('臺中市西區', 'weekend');
    assert.equal(weekend.isWeek, true);
    assert.equal(weekend.forecastDays, 2);
    assert.equal(weekend.city, '臺中市西區');
    assert.equal(weekend.source, 'cwa');
    const lines = weekend.weekSummary.split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith('10/17：'), lines[0]);
    assert.ok(lines[1].startsWith('10/18：'), lines[1]);
    assert.match(lines[0], /^10\/17：.+，\d+°C～\d+°C，降雨機率 \d+%$/u);
    // It is not today (Wednesday), and it is not the one-day answer of a single date.
    assert.equal(weekend.description, undefined);
    assert.equal(weekend.forecastPeriod, undefined);

    const reply = await getWeatherMentionReply('這週末台中西區天氣');
    assert.match(reply, /^臺中市西區週末天氣：\n10\/17：.+\n10\/18：.+\n中央氣象署預報$/u);
    assert.doesNotMatch(reply, /未來/u);
  });
});

test('CWA: on Saturday both days are listed, on Sunday only Sunday', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: taipei('2026-10-17 09:00') }); // Saturday
  await withProviders({ cwa: districtResponse('高雄市', '前鎮區', '64000090', forecastDays(7, Date.now())) }, async () => {
    const saturday = await getWeather('高雄市前鎮區', 'weekend');
    assert.deepEqual(saturday.weekSummary.split('\n').map((line) => line.slice(0, 5)), ['10/17', '10/18']);
    assert.equal(saturday.forecastDays, 2);
  });

  t.mock.timers.setTime(taipei('2026-10-18 20:00')); // Sunday evening
  await withProviders({ cwa: districtResponse('臺南市', '安平區', '67000360', forecastDays(7, Date.now())) }, async () => {
    const sunday = await getWeather('臺南市安平區', 'weekend');
    assert.deepEqual(sunday.weekSummary.split('\n').map((line) => line.slice(0, 5)), ['10/18']);
    assert.equal(sunday.forecastDays, 1);
    const reply = await getWeatherMentionReply('週末臺南安平天氣');
    assert.match(reply, /^臺南市安平區週末天氣：\n10\/18：.+\n中央氣象署預報$/u);
  });
});

test('CWA: a weekend the forecast does not reach is an unavailable forecast, never another day', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: taipei('2026-10-12 10:00') }); // Monday
  // Three days of data: Monday to Wednesday.
  await withProviders({ cwa: districtResponse('宜蘭縣', '礁溪鄉', '10002050', forecastDays(3, Date.now())) }, async () => {
    await assert.rejects(getWeather('宜蘭縣礁溪鄉', 'weekend'), (error) =>
      error instanceof WeatherError
      && error.code === 'forecast_unavailable'
      && error.message === FORECAST_UNAVAILABLE_MESSAGE
      && error.message === '該日期目前沒有可用的預報。');
    assert.equal(await getWeatherMentionReply('這週末宜蘭礁溪天氣'), FORECAST_UNAVAILABLE_MESSAGE);
  });

  // Three days of data from Thursday reach Saturday but not Sunday: the day that is in the data is
  // listed, and the day that is not is not made up.
  t.mock.timers.setTime(taipei('2026-10-15 10:00'));
  await withProviders({ cwa: districtResponse('花蓮縣', '壽豐鄉', '10015040', forecastDays(3, Date.now())) }, async () => {
    // Thursday, Friday, Saturday: Saturday only.
    const partial = await getWeather('花蓮縣壽豐鄉', 'weekend');
    assert.deepEqual(partial.weekSummary.split('\n').map((line) => line.slice(0, 5)), ['10/17']);
    assert.equal(partial.forecastDays, 1);
  });
});

test('CWA: today, tomorrow, the day after tomorrow and the week are unchanged', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: taipei('2026-10-14 10:00') });
  const days = forecastDays(7, Date.now());
  await withProviders({ cwa: districtResponse('屏東縣', '東港鎮', '10013080', days) }, async () => {
    for (const [time, index] of [['today', 0], ['tomorrow', 1], ['day_after_tomorrow', 2]]) {
      const weather = await getWeather('屏東縣東港鎮', time);
      assert.equal(weather.forecastPeriod, days[index].date, time);
      assert.equal(weather.isWeek, undefined, time);
    }
    const week = await getWeather('屏東縣東港鎮', 'week');
    assert.equal(week.forecastDays, 7);
    assert.equal(week.weekSummary.split('\n').length, 7);
    assert.ok(week.weekSummary.startsWith(`${slashDate(days[0].date)}：`));
  });
});

test('OpenWeather: a weekend question lists the weekend days the forecast reaches', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: taipei('2026-10-14 10:00') }); // Wednesday
  await withProviders({ openWeather: { current: OPENWEATHER_CURRENT, forecast: openWeatherForecast(Date.now()) } }, async (requests) => {
    const weekend = await getWeather('Tokyo', 'weekend');
    assert.equal(weekend.isWeek, true);
    assert.equal(weekend.source, 'openweather');
    assert.equal(weekend.sourceLabel, 'OpenWeather 預報');
    assert.equal(weekend.city, 'Tokyo, JP');
    assert.deepEqual(weekend.weekSummary.split('\n').map((line) => line.slice(0, 5)), ['10/17', '10/18']);
    assert.match(weekend.weekSummary.split('\n')[0], /^10\/17: 多雲, 18°C~24°C, 降雨率 30%$/u);
    // The forecast of the day after tomorrow is not what "weekend" used to give (tomorrow's).
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path.endsWith('/forecast'), true);

    const reply = await getWeatherMentionReply('weekend weather in Tokyo');
    assert.match(reply, /^Tokyo, JP週末天氣：\n10\/17: 多雲.+\n10\/18: 多雲.+\nOpenWeather 預報$/u);
  });

  // On Monday the 5-day forecast reaches Saturday morning only.
  t.mock.timers.setTime(taipei('2026-10-12 10:00'));
  await withProviders({ openWeather: { current: OPENWEATHER_CURRENT, forecast: openWeatherForecast(Date.now()) } }, async () => {
    const partial = await getWeather('Tokyo', 'weekend');
    assert.deepEqual(partial.weekSummary.split('\n').map((line) => line.slice(0, 5)), ['10/17']);
  });

  // A forecast that does not reach the weekend at all.
  await withProviders({ openWeather: { current: OPENWEATHER_CURRENT, forecast: openWeatherForecast(Date.now(), 8) } }, async () => {
    await assert.rejects(getWeather('Tokyo', 'weekend'), (error) =>
      error instanceof WeatherError && error.code === 'forecast_unavailable'
      && error.message === FORECAST_UNAVAILABLE_MESSAGE);
    assert.equal(await getWeatherMentionReply('Tokyo weather this weekend'), FORECAST_UNAVAILABLE_MESSAGE);
  });

  // On Sunday only Sunday.
  t.mock.timers.setTime(taipei('2026-10-18 08:00'));
  await withProviders({ openWeather: { current: OPENWEATHER_CURRENT, forecast: openWeatherForecast(Date.now()) } }, async () => {
    const sunday = await getWeather('Tokyo', 'weekend');
    assert.deepEqual(sunday.weekSummary.split('\n').map((line) => line.slice(0, 5)), ['10/18']);
  });
});

test('OpenWeather: the week answer keeps its format', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: taipei('2026-10-14 10:00') });
  await withProviders({ openWeather: { current: OPENWEATHER_CURRENT, forecast: openWeatherForecast(Date.now()) } }, async () => {
    const week = await getWeather('Tokyo', 'week');
    assert.equal(week.isWeek, true);
    assert.equal(week.forecastDays, 5);
    assert.deepEqual(week.weekSummary.split('\n').map((line) => line.slice(0, 5)),
      ['10/14', '10/15', '10/16', '10/17', '10/18']);
    assert.match(week.weekSummary.split('\n')[0], /^10\/14: 多雲, 18°C~24°C, 降雨率 30%$/u);
    const reply = await getWeatherMentionReply('weather in Tokyo this week');
    assert.ok(reply.startsWith('Tokyo, JP未來5日預報：\n10/14: '), reply);
  });
});

// ---------------------------------------------------------------------------
// The /weather command
// ---------------------------------------------------------------------------

test('the city option names examples that all work, and the command answers a Chinese city name', async () => {
  const option = weatherCommand.data.toJSON().options.find((item) => item.name === 'city');
  const examples = option.description.replace(/^[^，]*，例如\s*/u, '').split('、');
  assert.deepEqual(examples, ['Taipei', '臺北市信義區', '新北市新莊區', 'Tokyo']);
  assert.ok(option.description.length <= 100);
  for (const example of examples) {
    const resolved = normalizeWeatherCommandLocation(example);
    assert.equal(resolved.ambiguous, null, example);
    assert.equal(resolved.invalid, null, example);
  }
  // The old examples were ambiguous, which is why they were replaced.
  assert.ok(normalizeWeatherCommandLocation('新竹').ambiguous);
  assert.ok(normalizeWeatherCommandLocation('信義區').ambiguous);

  // The type choices are the same three as before.
  const type = weatherCommand.data.toJSON().options.find((item) => item.name === 'type');
  assert.deepEqual(type.choices.map((choice) => choice.value), ['today', 'tomorrow', 'week']);

  await withProviders({ openWeather: { current: OPENWEATHER_CURRENT, forecast: openWeatherForecast(Date.now()) } }, async (requests) => {
    let reply;
    await weatherCommand.execute({
      options: { getString: (name) => (name === 'city' ? '東京' : 'today') },
      inGuild: () => false,
      deferReply: async () => {},
      editReply: async (payload) => { reply = payload; },
    });
    const embed = reply.embeds[0].toJSON();
    assert.equal(embed.title, 'Tokyo, JP 今天天氣');
    assert.deepEqual(requests.map((request) => request.q), ['Tokyo']);
  });
});

test('a Chinese overseas city name given straight to the service is asked for in English', async () => {
  await withProviders({ openWeather: { current: OPENWEATHER_CURRENT, forecast: openWeatherForecast(Date.now()) } }, async (requests) => {
    assert.equal((await getWeather('東京', 'today')).city, 'Tokyo, JP');
    assert.equal((await getWeather('東京', 'tomorrow')).source, 'openweather');
    assert.equal((await getWeather('大阪', 'week')).isWeek, true);
    assert.deepEqual(requests.map((request) => request.q), ['Tokyo', 'Tokyo', 'Osaka']);
  });
});
