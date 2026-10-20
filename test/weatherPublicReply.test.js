const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dailyCwaForecast,
  getWeather,
  safeErrorCode,
  WeatherError,
  CITY_NOT_FOUND_MESSAGE,
} = require('../src/services/weatherService');
const {
  normalizeWeatherCommandLocation,
  parseWeatherQuery,
  TAIWAN_DISTRICTS,
} = require('../src/utils/weatherNLP');
const taiwanDistrictTable = require('../src/utils/taiwanDistricts.json');
const weatherCommand = require('../src/commands/weather');
const { SAFETY_EVENT_CODES, setSafetyEventHandler } = require('../src/platform/safetyEventCatalog');
const { sanitizeUserFacingOutput } = require('../src/systems/conversation/userFacingOutputPolicy');
const { getWeatherMentionReply } = require('../src/coordinators/conversationCoordinator');
const {
  clearConversationSafetyEventHandlerForTests,
  setConversationSafetyEventHandler,
} = require('../src/systems/conversation/safetyEvents');
const {
  OFFICIAL_THREE_HOUR_ELEMENT_NAMES,
  OFFICIAL_WEEK_ELEMENT_NAMES,
  legacyWeekResponse,
  officialThreeHourLocation,
  officialWeekLocation,
  officialWeekResponse,
} = require('./fixtures/cwaForecastFixtures');

function taiwanDate(offset = 0) {
  const date = new Date(Date.now() + offset * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

// The footer for a payload whose IssueTime is `${taiwanDate()}T05:30:00+08:00`:
// the time is shown in Taiwan time, so 05:30 here and not 21:30 of the day before in UTC.
function issuedFooter() {
  const issued = new Date(`${taiwanDate()}T05:30:00+08:00`);
  return `中央氣象署預報，發布於 ${issued.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}（台灣時間）`;
}

function response(status, json) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: typeof json === 'function' ? json : async () => json,
  };
}

async function withCwaFetch(fetchImplementation, callback) {
  const originalFetch = global.fetch;
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'CWA_API_KEY');
  const originalKey = process.env.CWA_API_KEY;
  process.env.CWA_API_KEY = 'synthetic-cwa-key';
  global.fetch = fetchImplementation;
  try {
    return await callback();
  } finally {
    global.fetch = originalFetch;
    if (hadKey) process.env.CWA_API_KEY = originalKey;
    else delete process.env.CWA_API_KEY;
  }
}

async function withOpenWeatherFetch(fetchImplementation, callback) {
  const originalFetch = global.fetch;
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'OPENWEATHER_API_KEY');
  const originalKey = process.env.OPENWEATHER_API_KEY;
  process.env.OPENWEATHER_API_KEY = 'synthetic-openweather-key';
  global.fetch = fetchImplementation;
  try {
    return await callback();
  } finally {
    global.fetch = originalFetch;
    if (hadKey) process.env.OPENWEATHER_API_KEY = originalKey;
    else delete process.env.OPENWEATHER_API_KEY;
  }
}

function uppercaseIntervals(valueName, values) {
  return values.map((value, index) => ({
    StartTime: `${taiwanDate(index)}T06:00:00+08:00`,
    EndTime: `${taiwanDate(index)}T18:00:00+08:00`,
    ElementValue: [value === undefined ? {} : { [valueName]: value }],
  }));
}

function uppercaseCwaFixture({ county, district, geocode, missing = false }) {
  const values = missing ? [undefined, undefined] : null;
  return {
    success: 'true',
    records: {
      Locations: [{
        DatasetInfo: { IssueTime: `${taiwanDate()}T05:30:00+08:00` },
        LocationsName: county,
        Location: [{
          LocationName: district,
          Geocode: geocode,
          WeatherElement: [
            { ElementName: '天氣預報綜合描述', Time: uppercaseIntervals('WeatherDescription', ['晴時多雲', '多雲短暫雨']) },
            { ElementName: '最低溫度', Time: uppercaseIntervals('MinTemperature', values || ['22', '23']) },
            { ElementName: '最高溫度', Time: uppercaseIntervals('MaxTemperature', values || ['29', '28']) },
            { ElementName: '最高體感溫度', Time: uppercaseIntervals('MaxApparentTemperature', values || ['31', '30']) },
            { ElementName: '相對濕度', Time: uppercaseIntervals('RelativeHumidity', values || ['70', '75']) },
            {
              ElementName: '風向風速',
              Time: [0, 1].map((index) => ({
                StartTime: `${taiwanDate(index)}T06:00:00+08:00`,
                EndTime: `${taiwanDate(index)}T18:00:00+08:00`,
                ElementValue: [missing ? { WindDirection: '-' } : { WindDirection: '東北風', WindSpeed: '4' }],
              })),
            },
            { ElementName: '降雨機率', Time: uppercaseIntervals('ProbabilityOfPrecipitation', values || ['30', '60']) },
          ],
        }],
      }],
    },
  };
}

function lowercaseCwaFixture() {
  const interval = (value) => [{
    startTime: `${taiwanDate()}T06:00:00+08:00`,
    endTime: `${taiwanDate()}T18:00:00+08:00`,
    elementValue: [{ value }],
  }];
  return {
    success: true,
    records: {
      locations: [{
        datasetInfo: { issueTime: `${taiwanDate()}T05:30:00+08:00` },
        locationsName: '新北市',
        location: [{
          locationName: '新莊區',
          geocode: '65000050',
          weatherElement: [
            { elementName: '天氣預報綜合描述', time: interval('晴') },
            { elementName: '最低溫度', time: interval('21') },
            { elementName: '最高溫度', time: interval('27') },
            { elementName: '降雨機率', time: interval('10') },
          ],
        }],
      }],
    },
  };
}

// Forecast days shared by the official-format and legacy-format tests. Every
// expected string is derived from this table so each assertion can be traced.
// BeaufortScale differs from WindSpeed so a Beaufort level cannot pass as m/s.
function forecastDays() {
  return [
    {
      date: taiwanDate(0), weather: '多雲時晴', description: '多雲時晴。降雨機率 40%。溫度攝氏 22 至 29 度。',
      min: 22, max: 29, apparentMax: 31, humidity: 70,
      windSpeed: 4, beaufort: 3, windDirection: '東北風', pop: [20, 40],
    },
    {
      date: taiwanDate(1), weather: '陰短暫雨', description: '陰短暫雨。降雨機率 70%。溫度攝氏 21 至 26 度。',
      min: 21, max: 26, apparentMax: 27, humidity: 82,
      windSpeed: 5, beaufort: 3, windDirection: '北風', pop: [60, 70],
    },
    {
      date: taiwanDate(2), weather: '多雲', description: '多雲。降雨機率 30%。溫度攝氏 20 至 27 度。',
      min: 20, max: 27, apparentMax: 28, humidity: 65,
      windSpeed: 2, beaufort: 1, windDirection: '東風', pop: [10, 30],
    },
  ];
}

// Rain chance, humidity, wind speed, and wind direction must all be filled, and
// the daily values must come from the day and night windows of the feed.
function assertForecastMatchesDay(weather, day, label) {
  assert.notEqual(weather.pop, null, `${label}: rain chance is empty`);
  assert.notEqual(weather.humidity, '無資料', `${label}: humidity is empty`);
  assert.notEqual(weather.windSpeed, '無資料', `${label}: wind speed is empty`);
  assert.ok(weather.windDirection, `${label}: wind direction is empty`);

  assert.equal(weather.description, day.weather, label);
  assert.equal(weather.tempMin, `${day.min}°C`, label);
  assert.equal(weather.tempMax, `${day.max}°C`, label);
  assert.equal(weather.feelsLike, `${day.apparentMax}°C`, label);
  assert.equal(weather.humidity, `${day.humidity}%`, label);
  assert.equal(weather.windDirection, day.windDirection, label);
  assert.equal(weather.windSpeed, `${day.windSpeed} m/s`, label);
  assert.equal(weather.pop, `${Math.max(...day.pop)}%`, label);
  assert.equal(weather.popRaw, Math.max(...day.pop), label);
}

async function runSlashWeather(city, type = 'today') {
  let reply;
  await weatherCommand.execute({
    options: { getString: (name) => (name === 'city' ? city : type) },
    inGuild: () => false,
    deferReply: async () => {},
    editReply: async (payload) => { reply = payload; },
  });
  return reply;
}

// Every /weather reply must carry this: no @everyone, @here, user, or role pings.
const NO_MENTION_PARSING = { parse: [], users: [], roles: [], repliedUser: false };

// Collects logger output (console.warn) without its timestamp prefix.
function captureWarnings() {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.join(' ').replace(/^\[[^\]]+\] /, '')); };
  return { lines, restore: () => { console.warn = original; } };
}

test('Taiwan district table keeps exactly 368 townships with unique codes in 22 counties', () => {
  const { districts } = taiwanDistrictTable;
  assert.equal(districts.length, 368);
  assert.equal(new Set(districts.map((entry) => entry.districtCode)).size, 368);
  assert.equal(new Set(districts.map((entry) => `${entry.county}${entry.district}`)).size, 368);
  assert.equal(new Set(districts.map((entry) => entry.county)).size, 22);
  assert.equal(TAIWAN_DISTRICTS.length, districts.length);
});

test('Taiwan districts resolve to their county and district for a weather query', () => {
  for (const { county, district } of TAIWAN_DISTRICTS) {
    const location = `${county}${district}`;
    const resolved = normalizeWeatherCommandLocation(location);
    assert.equal(resolved.city, county, location);
    assert.equal(resolved.district, district, location);
    assert.equal(resolved.location, location);
    assert.equal(resolved.invalid, null);

    const naturalLanguage = parseWeatherQuery(`請問明天${location.replaceAll('臺', '台')}天氣如何？`);
    assert.equal(naturalLanguage.location, location, `natural language: ${location}`);
    assert.equal(naturalLanguage.time, 'tomorrow', `natural language: ${location}`);
  }

  const question = parseWeatherQuery('請問明天台北市大安區天氣如何？');
  assert.equal(question.location, '臺北市大安區');
  assert.equal(question.time, 'tomorrow');
});

test('Taiwan short names support suffix omission and explicitly disambiguate duplicate place names', () => {
  const examples = [
    ['苗栗三義', '苗栗縣', '三義鄉'],
    ['彰化員林', '彰化縣', '員林市'],
    ['屏東東港', '屏東縣', '東港鎮'],
    ['台東成功', '臺東縣', '成功鎮'],
    ['花蓮壽豐', '花蓮縣', '壽豐鄉'],
    ['金門金城', '金門縣', '金城鎮'],
    ['連江南竿', '連江縣', '南竿鄉'],
  ];
  for (const [input, county, district] of examples) {
    const resolved = normalizeWeatherCommandLocation(input);
    assert.equal(resolved.city, county, input);
    assert.equal(resolved.district, district, input);
  }

  for (const [input, candidates] of [
    ['新竹', ['新竹縣', '新竹市']],
    ['嘉義', ['嘉義市', '嘉義縣']],
  ]) {
    const resolved = normalizeWeatherCommandLocation(input);
    assert.equal(resolved.ambiguous, input);
    assert.deepEqual(new Set(resolved.candidates), new Set(candidates));
  }

  const eastDistrict = normalizeWeatherCommandLocation('東區');
  assert.equal(eastDistrict.ambiguous, '東區');
  assert.deepEqual(new Set(eastDistrict.candidates), new Set([
    '臺中市東區', '臺南市東區', '新竹市東區', '嘉義市東區',
  ]));
  assert.equal(normalizeWeatherCommandLocation('新竹東區').location, '新竹市東區');
});

test('an unknown district receives a clear public correction prompt', async () => {
  await assert.rejects(getWeather('臺北市不存在區'), (error) =>
    error instanceof WeatherError &&
    error.code === 'city_not_found' &&
    error.message === '請提供正確的縣市及行政區名稱。');
});

test('current CWA JSON fields drive current, forecast, week, slash, and AI replies consistently', async () => {
  let capturedRequest;
  let fetchCount = 0;
  await withCwaFetch(async (url, options) => {
    fetchCount += 1;
    capturedRequest = { url: String(url), options };
    return response(200, uppercaseCwaFixture({
      county: '臺北市', district: '大安區', geocode: '63000030',
    }));
  }, async () => {
    const today = await getWeather('台北市大安區', 'today');
    assert.equal(today.city, '臺北市大安區');
    assert.equal(today.description, '晴時多雲');
    assert.equal(today.tempMin, '22°C');
    assert.equal(today.tempMax, '29°C');
    assert.equal(today.feelsLike, '31°C');
    assert.equal(today.humidity, '70%');
    assert.equal(today.windDirection, '東北風');
    assert.equal(today.windSpeed, '4 m/s');
    assert.equal(today.pop, '30%');
    // An issue time in the payload keeps being shown.
    assert.equal(today.sourceLabel, issuedFooter());
    assert.match(today.sourceLabel, /5:30/);

    const tomorrow = await getWeather('臺北市大安區', 'tomorrow');
    assert.equal(tomorrow.description, '多雲短暫雨');
    assert.equal(tomorrow.pop, '60%');

    const week = await getWeather('臺北市大安區', 'week');
    assert.equal(week.forecastDays, 2);
    assert.match(week.weekSummary, /晴時多雲/);
    assert.match(week.weekSummary, /多雲短暫雨/);
    assert.equal(week.sourceLabel, issuedFooter());

    let slashReply;
    await weatherCommand.execute({
      options: { getString: (name) => (name === 'city' ? '台北市大安區' : 'tomorrow') },
      inGuild: () => false,
      deferReply: async () => {},
      editReply: async (payload) => { slashReply = payload; },
    });
    const slashEmbed = slashReply.embeds[0].toJSON();
    assert.equal(slashEmbed.title, '臺北市大安區 明日預報');
    assert.equal(slashEmbed.fields.find((item) => item.name === '溫度').value, '23°C ~ 28°C');
    assert.equal(slashEmbed.footer.text, issuedFooter());

    const aiReply = await getWeatherMentionReply('請問明天台北市大安區天氣如何？');
    assert.match(aiReply, /臺北市大安區明天天氣/);
    assert.match(aiReply, /氣溫：23°C ~ 28°C/);
    assert.match(aiReply, /降雨機率：60%/);
    assert.ok(aiReply.endsWith(`\n${issuedFooter()}`));
  });

  assert.equal(fetchCount, 1, 'shared service should reuse the same valid dataset cache');
  assert.equal(capturedRequest.options.headers.Authorization, 'synthetic-cwa-key');
  assert.equal(capturedRequest.url.includes('synthetic-cwa-key'), false);
  assert.equal(new URL(capturedRequest.url).searchParams.has('Authorization'), false);
});

test('legacy lowercase CWA JSON remains compatible', async () => {
  await withCwaFetch(async () => response(200, lowercaseCwaFixture()), async () => {
    const weather = await getWeather('新北市新莊區', 'today');
    assert.equal(weather.description, '晴');
    assert.equal(weather.tempMin, '21°C');
    assert.equal(weather.tempMax, '27°C');
    assert.equal(weather.pop, '10%');
    assert.equal(weather.sourceLabel, issuedFooter());
  });
});

test('the footer says only where the forecast comes from when the payload has no issue time', async () => {
  // Current format: nothing in the payload names an issue time, so no notice either.
  await withCwaFetch(async () => response(200, officialWeekResponse({
    county: '南投縣', district: '埔里鎮', geocode: '10008020', days: forecastDays(),
  })), async () => {
    assert.equal((await getWeather('南投縣埔里鎮', 'today')).sourceLabel, '中央氣象署預報');
    assert.equal((await getWeather('南投縣埔里鎮', 'week')).sourceLabel, '中央氣象署預報');

    const slash = (await runSlashWeather('南投縣埔里鎮')).embeds[0].toJSON();
    assert.equal(slash.footer.text, '中央氣象署預報');
    assert.equal(slash.title, '南投縣埔里鎮 今日預報', 'the label stays set, so the title is unchanged');

    const aiReply = await getWeatherMentionReply('請問今天南投縣埔里鎮天氣如何？');
    assert.ok(aiReply.endsWith('\n中央氣象署預報'));
    assert.doesNotMatch(aiReply, /未提供/);
  });

  // An issue time that cannot be read is left out instead of being shown.
  const garbled = uppercaseCwaFixture({ county: '苗栗縣', district: '三義鄉', geocode: '10005130' });
  garbled.records.Locations[0].DatasetInfo = { IssueTime: 'not a time' };
  await withCwaFetch(async () => response(200, garbled), async () => {
    assert.equal((await getWeather('苗栗縣三義鄉', 'today')).sourceLabel, '中央氣象署預報');
  });

  // DatasetInfo at the level of records still supplies the issue time.
  const recordsLevel = uppercaseCwaFixture({ county: '彰化縣', district: '員林市', geocode: '10007100' });
  delete recordsLevel.records.Locations[0].DatasetInfo;
  recordsLevel.records.DatasetInfo = { IssueTime: `${taiwanDate()}T05:30:00+08:00` };
  await withCwaFetch(async () => response(200, recordsLevel), async () => {
    assert.equal((await getWeather('彰化縣員林市', 'today')).sourceLabel, issuedFooter());
  });
});

test('official one-week ElementName values fill rain chance, humidity, wind speed, and wind direction', async () => {
  const days = forecastDays();
  const location = officialWeekLocation({ name: '西區', geocode: '66000040', days });
  assert.deepEqual(
    location.WeatherElement.map((item) => item.ElementName).sort(),
    [...OFFICIAL_WEEK_ELEMENT_NAMES].sort(),
    'the fixture must expose exactly the ElementName values the official swagger lists',
  );

  await withCwaFetch(async () => response(200, officialWeekResponse({
    county: '臺中市', district: '西區', geocode: '66000040', days,
  })), async () => {
    for (const [index, time] of [[0, 'today'], [1, 'tomorrow'], [2, 'day_after_tomorrow']]) {
      assertForecastMatchesDay(await getWeather('臺中市西區', time), days[index], time);
    }

    const week = await getWeather('臺中市西區', 'week');
    assert.equal(week.forecastDays, 3);
    // Each line ends with that day's rain segment, so a percentage inside the
    // forecast text cannot satisfy the check.
    assert.deepEqual(
      week.weekSummary.split('\n').map((line) => line.split('，').at(-1)),
      ['降雨機率 40%', '降雨機率 70%', '降雨機率 30%'],
    );

    // The same data reaches the slash embed and the AI-path reply.
    const slash = await runSlashWeather('臺中市西區');
    const fields = Object.fromEntries(slash.embeds[0].toJSON().fields.map((item) => [item.name, item.value]));
    assert.equal(fields['濕度'], '70%');
    assert.equal(fields['風速'], '4 m/s');
    assert.equal(fields['風向'], '東北風');
    assert.equal(fields['降雨機率'], '40%');

    const aiReply = await getWeatherMentionReply('請問今天臺中市西區天氣如何？');
    assert.match(aiReply, /降雨機率：40%/);
    assert.match(aiReply, /風向：東北風/);
    assert.match(aiReply, /風速：4 m\/s/);
  });
});

test('legacy English factor codes with a combined Wind element remain compatible', async () => {
  const days = forecastDays();
  await withCwaFetch(async () => response(200, legacyWeekResponse({
    county: '臺南市', district: '安平區', geocode: '67000360', days, wind: 'combined',
  })), async () => {
    assertForecastMatchesDay(await getWeather('臺南市安平區', 'today'), days[0], 'legacy Wind');
  });
});

test('legacy WS and WD elements merge into one wind reading', async () => {
  const days = forecastDays();
  await withCwaFetch(async () => response(200, legacyWeekResponse({
    county: '宜蘭縣', district: '礁溪鄉', geocode: '10002050', days, wind: 'split',
  })), async () => {
    assertForecastMatchesDay(await getWeather('宜蘭縣礁溪鄉', 'tomorrow'), days[1], 'legacy WS and WD');
  });
});

test('official-format values marked "-" stay unavailable instead of becoming zero', async () => {
  const days = forecastDays();
  await withCwaFetch(async () => response(200, officialWeekResponse({
    county: '高雄市', district: '前鎮區', geocode: '64000090', days, missing: true,
  })), async () => {
    const weather = await getWeather('高雄市前鎮區', 'today');
    assert.equal(weather.description, days[0].weather);
    assert.equal(weather.tempMin, '無資料');
    assert.equal(weather.tempMax, '無資料');
    assert.equal(weather.feelsLike, '無資料');
    assert.equal(weather.humidity, '無資料');
    assert.equal(weather.windSpeed, '無資料');
    assert.equal(weather.windDirection, null);
    assert.equal(weather.pop, null);
    assert.equal(weather.popRaw, null);
  });
});

test('ElementName matching tolerates full-width digits, stray spaces, and letter case', () => {
  const location = officialWeekLocation({ name: '西區', geocode: '66000040', days: forecastDays().slice(0, 1) });
  const renamed = new Map([
    ['12小時降雨機率', '１２小時降雨機率'],
    ['平均相對濕度', ' 平均相對濕度 '],
    ['風速', '風 速'],
    ['風向', 'wd'],
  ]);
  for (const element of location.WeatherElement) {
    if (renamed.has(element.ElementName)) element.ElementName = renamed.get(element.ElementName);
  }
  const [day] = dailyCwaForecast(location);
  assert.equal(day.pop, 40);
  assert.equal(day.humidity, 70);
  assert.equal(day.windSpeed, 4);
  assert.equal(day.windDirection, '東北風');
});

test('official three-day ElementName values are read as well', () => {
  const day = { ...forecastDays()[0], pop: [10, 40, 20] };
  const location = officialThreeHourLocation({ name: '西區', geocode: '66000040', day });
  assert.deepEqual(
    location.WeatherElement.map((item) => item.ElementName).sort(),
    [...OFFICIAL_THREE_HOUR_ELEMENT_NAMES].sort(),
    'the fixture must expose exactly the ElementName values the official swagger lists',
  );
  const forecast = dailyCwaForecast(location);
  assert.equal(forecast.length, 1);
  assert.equal(forecast[0].date, day.date);
  assert.equal(forecast[0].description, day.weather);
  assert.equal(forecast[0].pop, 40);
  assert.equal(forecast[0].humidity, 70);
  assert.equal(forecast[0].apparent, 31);
  assert.equal(forecast[0].windSpeed, 4);
  assert.equal(forecast[0].windDirection, '東北風');
});

test('split wind elements contribute only their own half and never a Beaufort level', () => {
  const start = `${taiwanDate(0)}T06:00:00+08:00`;
  const interval = (elementValue) => [{ StartTime: start, EndTime: `${taiwanDate(0)}T18:00:00+08:00`, ElementValue: [elementValue] }];

  // A wind-speed element that carries only a Beaufort level has no m/s value.
  const beaufortOnly = dailyCwaForecast({
    WeatherElement: [
      { ElementName: '風速', Time: interval({ BeaufortScale: '3' }) },
      { ElementName: '風向', Time: interval({ WindDirection: '東北風' }) },
    ],
  });
  assert.equal(beaufortOnly[0].windSpeed, undefined);
  assert.equal(beaufortOnly[0].windDirection, '東北風');

  // A bare number in the direction element is not a speed, and bare text in the
  // speed element is not a direction.
  const crossed = dailyCwaForecast({
    WeatherElement: [
      { ElementName: '風向', Time: interval({ value: '45' }) },
      { ElementName: '風速', Time: interval({ value: '偏北風' }) },
    ],
  });
  assert.equal(crossed[0].windSpeed, undefined);
  assert.equal(crossed[0].windDirection, undefined);
});

test('Taiwan city-only queries read the nationwide CWA dataset', async () => {
  let requestUrl;
  await withCwaFetch(async (url) => {
    requestUrl = String(url);
    return response(200, uppercaseCwaFixture({
      county: '臺灣', district: '臺北市', geocode: '63',
    }));
  }, async () => {
    const weather = await getWeather('台北', 'today');
    assert.equal(weather.city, '臺北市');
    assert.equal(weather.tempMin, '22°C');
    assert.equal(weather.tempMax, '29°C');
  });
  assert.match(requestUrl, /\/F-D0047-091(?:\?|$)/);
});

test('missing CWA values stay unavailable instead of becoming zero or a normal forecast', async () => {
  await withCwaFetch(async () => response(200, uppercaseCwaFixture({
    county: '桃園市', district: '中壢區', geocode: '68000020', missing: true,
  })), async () => {
    const weather = await getWeather('桃園市中壢區', 'today');
    assert.equal(weather.tempMin, '無資料');
    assert.equal(weather.tempMax, '無資料');
    assert.equal(weather.feelsLike, '無資料');
    assert.equal(weather.humidity, '無資料');
    assert.equal(weather.windSpeed, '無資料');
    assert.equal(weather.windDirection, null);
    assert.equal(weather.pop, null);
    assert.equal(weather.tempMinRaw, null);
    assert.equal(weather.tempMaxRaw, null);
    assert.equal(weather.popRaw, null);
  });
});

test('missing overseas current-weather values also stay unavailable', async () => {
  await withOpenWeatherFetch(async () => response(200, {
    name: 'London',
    sys: { country: 'GB' },
    weather: [{ description: '多雲' }],
    main: {},
    wind: {},
  }), async () => {
    const weather = await getWeather('London', 'today');
    assert.equal(weather.city, 'London, GB');
    assert.equal(weather.tempMin, '無資料');
    assert.equal(weather.tempMax, '無資料');
    assert.equal(weather.feelsLike, '無資料');
    assert.equal(weather.humidity, '無資料');
    assert.equal(weather.windSpeed, '無資料');
    assert.equal(weather.tempMinRaw, null);
    assert.equal(weather.tempMaxRaw, null);
    assert.equal(weather.popRaw, null);
  });
});

test('slash weather sanitizes external text and disables mention parsing', async () => {
  await withOpenWeatherFetch(async () => response(200, {
    name: 'London',
    sys: { country: 'GB' },
    weather: [{ description: '多雲 https://evil.example/redirect @everyone <@&123456789012345678>' }],
    main: { temp_min: 10, temp_max: 12, feels_like: 9, humidity: 80 },
    wind: { speed: 3 },
  }), async () => {
    let slashReply;
    await weatherCommand.execute({
      user: { id: 'weather-user' },
      guildId: 'weather-guild',
      channelId: 'weather-channel',
      options: { getString: (name) => (name === 'city' ? 'London' : 'today') },
      inGuild: () => false,
      deferReply: async () => {},
      editReply: async (payload) => { slashReply = payload; },
    });
    const embed = slashReply.embeds[0].toJSON();
    assert.match(embed.description, /多雲/);
    assert.doesNotMatch(embed.description, /evil\.example|@everyone|<@&/);
    assert.deepEqual(slashReply.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  });
});

test('CWA authorization, throttling, invalid JSON, and empty data have stable error classes', async () => {
  await withCwaFetch(async () => response(401, {}), async () => {
    await assert.rejects(getWeather('新竹縣竹北市'), (error) =>
      error instanceof WeatherError && error.code === 'unauthorized');
  });

  await withCwaFetch(async () => response(429, {}), async () => {
    await assert.rejects(getWeather('新竹市東區'), (error) =>
      error instanceof WeatherError && error.code === 'rate_limited');
    const reply = await getWeatherMentionReply('新竹市東區天氣');
    assert.equal(reply, '天氣資料暫時無法查詢，請稍後再試。');
    assert.doesNotMatch(reply, /小吉有點累了/);
  });

  await withCwaFetch(async () => response(200, async () => { throw new SyntaxError('synthetic'); }), async () => {
    await assert.rejects(getWeather('嘉義縣太保市'), (error) =>
      error instanceof WeatherError && error.code === 'invalid_response');
  });

  await withCwaFetch(async () => response(200, { success: 'true', records: { Locations: [] } }), async () => {
    await assert.rejects(getWeather('嘉義市東區'), (error) =>
      error instanceof WeatherError && error.code === 'empty_response');
  });

  await withCwaFetch(async () => response(200, { success: 'false', records: {} }), async () => {
    await assert.rejects(getWeather('屏東縣東港鎮'), (error) =>
      error instanceof WeatherError && error.code === 'provider_error');
  });
});

test('a link in third-party weather text is cleaned and logged but is no security alert for the Owner', async () => {
  await withOpenWeatherFetch(async () => response(200, {
    name: 'London',
    sys: { country: 'GB' },
    weather: [{ description: '多雲 https://evil.example/redirect @everyone' }],
    main: { temp_min: 10, temp_max: 12, feels_like: 9, humidity: 80 },
    wind: { speed: 3 },
  }), async () => {
    const alerts = [];
    const conversationEvents = [];
    const restoreSafety = setSafetyEventHandler((event) => alerts.push(event));
    const restoreConversation = setConversationSafetyEventHandler((event) => conversationEvents.push(event.code));
    try {
      await weatherCommand.execute({
        user: { id: 'weather-user' },
        guildId: 'weather-guild',
        channelId: 'weather-channel',
        options: { getString: (name) => (name === 'city' ? 'London' : 'today') },
        inGuild: () => false,
        deferReply: async () => {},
        editReply: async () => {},
      });
      // The AI reply clean-up, by contrast, does raise one (the default of sanitizeUserFacingOutput).
      sanitizeUserFacingOutput('see https://evil.example/x', { context: { guildId: 'weather-guild', actorId: 'weather-user' } });
    } finally {
      restoreSafety();
      restoreConversation();
    }
    assert.ok(conversationEvents.includes('AI_OUTPUT_URL_BLOCKED'), 'the clean-up is still reported to the conversation hook');
    assert.deepEqual(alerts.map((event) => [event.code, event.notice.alertKind]),
      [[SAFETY_EVENT_CODES.OWNER_EVENT_SECURITY_ALERT, 'output-guard']], 'only the AI reply clean-up raised an alert');
  });
});

test('slash weather failures log only an identifier and keep the friendly reply', async () => {
  const warnings = captureWarnings();
  const failWith = (error) => async () => { throw error; };
  const replies = [];
  try {
    // A WeatherError carries a stable code.
    await withCwaFetch(async () => response(429, {}), async () => {
      replies.push(await runSlashWeather('花蓮縣壽豐鄉'));
    });
    // An unexpected error is logged by name; the URL and key in its message are not.
    await withOpenWeatherFetch(failWith(new TypeError(
      'fetch failed https://api.openweathermap.org/data/2.5/weather?q=London&appid=synthetic-openweather-key',
    )), async () => {
      replies.push(await runSlashWeather('London'));
    });
    // An error code wins over the error name.
    await withOpenWeatherFetch(failWith(Object.assign(new Error('connect failed'), { code: 'ECONNRESET' })), async () => {
      replies.push(await runSlashWeather('London'));
    });
    // A code that is not a plain identifier is skipped for the next safe one, the name.
    await withOpenWeatherFetch(failWith(Object.assign(new Error('odd'), {
      code: 'https://example.invalid/path?credential=synthetic-credential',
    })), async () => {
      replies.push(await runSlashWeather('London'));
    });
    // With nothing safe left the log says "unknown".
    await withOpenWeatherFetch(failWith(Object.assign(new Error('odd'), {
      name: 'not an identifier!',
      code: 'https://example.invalid/path?credential=synthetic-credential',
    })), async () => {
      replies.push(await runSlashWeather('London'));
    });
  } finally {
    warnings.restore();
  }

  assert.deepEqual(replies.map((reply) => reply.content), [
    '臺灣天氣資料暫時無法查詢，請稍後再試。',
    '查詢天氣失敗，請稍後再試。',
    '查詢天氣失敗，請稍後再試。',
    '查詢天氣失敗，請稍後再試。',
    '查詢天氣失敗，請稍後再試。',
  ]);
  for (const reply of replies) assert.deepEqual(reply.allowedMentions, NO_MENTION_PARSING);
  assert.deepEqual(warnings.lines, [
    '[warn] weather command failed: rate_limited',
    '[warn] weather command failed: TypeError',
    '[warn] weather command failed: ECONNRESET',
    '[warn] weather command failed: Error',
    '[warn] weather command failed: unknown',
  ]);
  assert.equal(warnings.lines.some((line) => /https?:|openweathermap|appid|credential|synthetic-/i.test(line)), false);
});

test('safeErrorCode prefers the network cause, then a string code, then the name, then a numeric code', () => {
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.equal(timeout.code, 23, 'a DOMException carries a legacy numeric code that must not hide its name');
  const throwingText = { toString() { throw new Error('must never be stringified'); } };
  const cases = [
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), 'ECONNRESET'],
    [Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' }), 'ENOTFOUND'],
    [new WeatherError('provider is down', 'provider_error'), 'provider_error'],
    [timeout, 'TimeoutError'],
    [new DOMException('This operation was aborted', 'AbortError'), 'AbortError'],
    [Object.assign(new Error('unknown interaction'), { name: 'DiscordAPIError[10062]', code: 10062 }), '10062'],
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'not safe!' } }), 'TypeError'],
    [Object.assign(new TypeError('terminated'), { cause: timeout }), 'TypeError'],
    [Object.assign(new Error('odd'), { code: 'https://example.invalid/?key=value' }), 'Error'],
    [Object.assign(new Error('odd'), { name: 'not safe!', code: 'not safe!' }), 'unknown'],
    [Object.assign(new Error('odd'), { name: 'B'.repeat(65), code: 'A'.repeat(65) }), 'unknown'],
    [{ name: throwingText, code: throwingText, cause: { code: throwingText } }, 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
    ['plain text', 'unknown'],
    [42, 'unknown'],
  ];
  for (const [error, expected] of cases) assert.equal(safeErrorCode(error), expected);
});

test('every /weather reply disables mention parsing, even for city_not_found', async () => {
  const warnings = captureWarnings();
  const replies = [];
  const typedMentions = ['@everyone', '@here', '<@123456789012345678>', '<@&123456789012345678>'];
  try {
    // The OpenWeather 404 reply now uses a fixed message (no user input echoed).
    await withOpenWeatherFetch(async () => response(404, {}), async () => {
      for (const input of typedMentions) {
        const reply = await runSlashWeather(input);
        assert.equal(reply.content, CITY_NOT_FOUND_MESSAGE, `${input} receives fixed message`);
        replies.push([input, reply]);
      }
    });
    // Replies that do not echo the input carry the same protection.
    replies.push(['ambiguous place', await runSlashWeather('東區')]);
    replies.push(['invalid district', await runSlashWeather('臺北市不存在區')]);
    await withCwaFetch(async () => response(429, {}), async () => {
      replies.push(['provider failure', await runSlashWeather('花蓮縣壽豐鄉')]);
    });
    await withOpenWeatherFetch(async () => { throw new TypeError('fetch failed'); }, async () => {
      replies.push(['unexpected failure', await runSlashWeather('London')]);
    });
    await withOpenWeatherFetch(async () => response(200, {
      name: 'London',
      sys: { country: 'GB' },
      weather: [{ description: '多雲' }],
      main: { temp_min: 10, temp_max: 12, feels_like: 9, humidity: 80 },
      wind: { speed: 3 },
    }), async () => {
      const reply = await runSlashWeather('London');
      assert.equal(reply.embeds.length, 1);
      replies.push(['weather embed', reply]);
    });
    let prompt;
    await weatherCommand.execute({
      options: { getString: () => null },
      inGuild: () => false,
      reply: async (payload) => { prompt = payload; },
    });
    replies.push(['missing city prompt', prompt]);
  } finally {
    warnings.restore();
  }

  assert.equal(replies.length, typedMentions.length + 6);
  for (const [label, reply] of replies) assert.deepEqual(reply.allowedMentions, NO_MENTION_PARSING, label);
  // The log carries identifiers only, never the typed text.
  assert.equal(warnings.lines.some((line) => /@everyone|@here|<@|123456789012345678/.test(line)), false);
});

test('CWA network failures keep a safe cause code in the log while the public error class is unchanged', async () => {
  const warnings = captureWarnings();
  const publicMessage = '臺灣天氣資料暫時無法查詢，請稍後再試。';
  const systemError = (code) => Object.assign(
    new Error(`request to https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-D0047-043?format=JSON failed: ${code}`),
    { code },
  );
  const fetchFailed = (cause) => Object.assign(new TypeError('fetch failed'), { cause });
  const requestFailures = [
    [fetchFailed(systemError('ECONNRESET')), 'ECONNRESET'],
    [fetchFailed(systemError('ETIMEDOUT')), 'ETIMEDOUT'],
    [new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 'TimeoutError'],
    [new DOMException('This operation was aborted', 'AbortError'), 'AbortError'],
    // A cause code that is not a plain identifier is dropped for the next safe one.
    [fetchFailed(systemError('https://opendata.cwa.gov.tw/?Authorization=synthetic-cwa-key')), 'TypeError'],
    [Object.assign(new Error('odd'), { name: 'not an identifier!' }), 'unknown'],
  ];
  const unreadableBodies = [
    [new SyntaxError('Unexpected token < in JSON'), 'SyntaxError'],
    [fetchFailed(systemError('UND_ERR_SOCKET')), 'UND_ERR_SOCKET'],
  ];
  const isPublicError = (code) => (thrown) => thrown instanceof WeatherError
    && thrown.code === code
    && thrown.message === publicMessage
    && thrown.cause === undefined;
  let slashReply;
  let aiReply;
  try {
    for (const [error] of requestFailures) {
      await withCwaFetch(async () => { throw error; }, async () => {
        await assert.rejects(getWeather('花蓮縣壽豐鄉'), isPublicError('provider_error'));
      });
    }
    for (const [error] of unreadableBodies) {
      await withCwaFetch(async () => response(200, async () => { throw error; }), async () => {
        await assert.rejects(getWeather('花蓮縣壽豐鄉'), isPublicError('invalid_response'));
      });
    }
    // The slash command and the AI path add their own line, so the log keeps both
    // the root cause and the public class.
    await withCwaFetch(async () => { throw fetchFailed(systemError('ECONNRESET')); }, async () => {
      slashReply = await runSlashWeather('花蓮縣壽豐鄉');
      aiReply = await getWeatherMentionReply('花蓮縣壽豐鄉天氣');
    });
  } finally {
    warnings.restore();
  }

  assert.equal(slashReply.content, publicMessage);
  assert.deepEqual(slashReply.allowedMentions, NO_MENTION_PARSING);
  assert.equal(aiReply, '天氣資料暫時無法查詢，請稍後再試。');
  assert.deepEqual(warnings.lines, [
    ...requestFailures.map(([, code]) => `[warn] CWA request failed: ${code}`),
    ...unreadableBodies.map(([, code]) => `[warn] CWA response unreadable: ${code}`),
    '[warn] CWA request failed: ECONNRESET',
    '[warn] weather command failed: provider_error',
    '[warn] CWA request failed: ECONNRESET',
    '[warn] weather mention failed: provider_error',
  ]);
  assert.equal(
    warnings.lines.some((line) => /https?:|opendata|datastore|F-D0047|Authorization|synthetic-|format=|\?/i.test(line)),
    false,
  );
});

test('AI weather replies log the same safe identifier as the slash command and keep their public text', async () => {
  const warnings = captureWarnings();
  const replies = [];
  try {
    // A raw network error: the cause code is logged (it used to be "unknown").
    await withOpenWeatherFetch(async () => {
      throw Object.assign(new TypeError(
        'fetch failed https://api.openweathermap.org/data/2.5/weather?q=London&appid=synthetic-openweather-key',
      ), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    }, async () => {
      replies.push(await getWeatherMentionReply('London天氣'));
    });
    // A code that is not a plain identifier used to be written to the log as is.
    await withOpenWeatherFetch(async () => {
      throw Object.assign(new Error('odd'), { code: 'https://example.invalid/path?credential=synthetic-credential' });
    }, async () => {
      replies.push(await getWeatherMentionReply('London天氣'));
    });
    // A WeatherError keeps its own code.
    await withCwaFetch(async () => response(429, {}), async () => {
      replies.push(await getWeatherMentionReply('花蓮縣壽豐鄉天氣'));
    });
    // A mistyped city gets its own answer and is not logged.
    await withOpenWeatherFetch(async () => response(404, {}), async () => {
      replies.push(await getWeatherMentionReply('Atlantis天氣'));
    });
  } finally {
    warnings.restore();
  }

  const unavailable = '天氣資料暫時無法查詢，請稍後再試。';
  assert.deepEqual(replies, [
    unavailable,
    unavailable,
    unavailable,
    '我找不到這個地名的天氣資料。請試著補上縣市與行政區，例如：臺北市大同區天氣。',
  ]);
  assert.deepEqual(warnings.lines, [
    '[warn] weather mention failed: ECONNRESET',
    '[warn] weather mention failed: Error',
    '[warn] weather mention failed: rate_limited',
  ]);
  assert.equal(warnings.lines.some((line) => /https?:|openweathermap|appid|credential|synthetic-/i.test(line)), false);
});

test('slash weather does not log a mistyped city but still logs every other error code', async () => {
  const warnings = captureWarnings();
  const typos = [];
  const failures = [];
  try {
    // OpenWeather answers 404 for a city it does not know: the user's typo, not a failure.
    await withOpenWeatherFetch(async () => response(404, {}), async () => {
      typos.push(await runSlashWeather('Atlantis'));
      typos.push(await runSlashWeather('@everyone'));
    });
    assert.deepEqual(warnings.lines, [], 'a mistyped city must stay out of the log');

    // Every other code keeps being logged, including a blank city name.
    await withOpenWeatherFetch(async () => response(500, {}), async () => {
      failures.push(await runSlashWeather('London'));
    });
    await withOpenWeatherFetch(async () => response(401, {}), async () => {
      failures.push(await runSlashWeather('London'));
    });
    await withOpenWeatherFetch(async () => response(404, {}), async () => {
      failures.push(await runSlashWeather('   '));
    });
    await withCwaFetch(async () => response(429, {}), async () => {
      failures.push(await runSlashWeather('花蓮縣壽豐鄉'));
    });
    // Only a WeatherError counts as a typo, the same test the AI path applies.
    await withOpenWeatherFetch(async () => {
      throw Object.assign(new Error('not a WeatherError'), { code: 'city_not_found' });
    }, async () => {
      failures.push(await runSlashWeather('London'));
    });
  } finally {
    warnings.restore();
  }

  // The user still gets the same reply, with mention parsing off.
  for (const reply of typos) {
    assert.equal(reply.content, CITY_NOT_FOUND_MESSAGE);
    assert.deepEqual(reply.allowedMentions, NO_MENTION_PARSING);
  }
  assert.deepEqual(failures.map((reply) => reply.content), [
    '天氣資料暫時無法查詢，請稍後再試。',
    '天氣資料暫時無法查詢，請稍後再試。',
    '請輸入城市名稱。',
    '臺灣天氣資料暫時無法查詢，請稍後再試。',
    '查詢天氣失敗，請稍後再試。',
  ]);
  for (const reply of failures) assert.deepEqual(reply.allowedMentions, NO_MENTION_PARSING);
  assert.deepEqual(warnings.lines, [
    '[warn] weather command failed: provider_error',
    '[warn] weather command failed: unauthorized',
    '[warn] weather command failed: missing_city',
    '[warn] weather command failed: rate_limited',
    '[warn] weather command failed: city_not_found',
  ]);
});

test('a mistyped city that looks like a link or mention is rewritten without raising a safety event', async () => {
  const events = [];
  const restore = setConversationSafetyEventHandler((event) => events.push(event));
  const links = [
    'https://example．com/login', // full-width period (U+FF0E)
    'http://2130706433/admin', // decimal IP
    'https://3232235777/login', // decimal IP over https
    'https://example.com/login', // ordinary address
  ];
  const mentions = ['@everyone', '@here', '<@123456789012345678>'];
  const plainNames = ['Atlantis', 'New York', '東京'];
  const replies = new Map();
  try {
    // Control: the success path reports a blocked link in external text, so the
    // handler is wired and silence below means something.
    await withOpenWeatherFetch(async () => response(200, {
      name: 'London',
      sys: { country: 'GB' },
      weather: [{ description: '多雲 https://evil.example/redirect' }],
      main: { temp_min: 10, temp_max: 12, feels_like: 9, humidity: 80 },
      wind: { speed: 3 },
    }), async () => {
      await runSlashWeather('London');
    });
    assert.ok(events.length > 0, 'control: the success path reports a blocked link');
    events.length = 0;

    // The 404 reply echoes the typed city back into a public message.
    await withOpenWeatherFetch(async () => response(404, {}), async () => {
      for (const input of [...links, ...mentions, ...plainNames]) replies.set(input, await runSlashWeather(input));
    });
    assert.deepEqual(events, [], 'a typed link or mention is not a safety event for the owner');
  } finally {
    restore();
    clearConversationSafetyEventHandlerForTests();
  }

  for (const input of links) {
    const reply = replies.get(input);
    assert.equal(reply.content, CITY_NOT_FOUND_MESSAGE, `link input: ${input}`);
  }
  for (const input of mentions) {
    const reply = replies.get(input);
    assert.equal(reply.content, CITY_NOT_FOUND_MESSAGE, `mention input: ${input}`);
  }
  // A normal city name also uses the fixed error message (no user input echoed).
  for (const input of plainNames) assert.equal(replies.get(input).content, CITY_NOT_FOUND_MESSAGE, `plain name input: ${input}`);
  for (const reply of replies.values()) assert.deepEqual(reply.allowedMentions, NO_MENTION_PARSING);
});

test('edge-case inputs (malformed links, extra-prefix mentions) receive fixed error message without echoing', async () => {
  const inputs = [
    'xhttps://evil．example/login', // URL with prefix alphanumeric (evades \b boundary)
    '1https://3232235777/', // URL with prefix digit
    'https://example．com/login', // full-width period (matches but now no echo)
    '@everyone',
    '<@&123456789012345678>', // role mention
    '<@123456789012345678>', // user mention
  ];
  const replies = new Map();
  try {
    await withOpenWeatherFetch(async () => response(404, {}), async () => {
      for (const input of inputs) replies.set(input, await runSlashWeather(input));
    });
  } finally {
    // (no safety events are logged)
  }

  for (const input of inputs) {
    const reply = replies.get(input);
    assert.equal(reply.content, CITY_NOT_FOUND_MESSAGE, `edge case input: ${input}`);
    assert.deepEqual(reply.allowedMentions, NO_MENTION_PARSING, `allowedMentions disabled for: ${input}`);
  }
});

test('blank values in the later days of a week stay unavailable instead of becoming 0', async () => {
  const days = forecastDays().map((day, index) => (index === 0 ? day : { ...day, blank: ' ' }));
  await withCwaFetch(async () => response(200, officialWeekResponse({
    county: '雲林縣', district: '斗六市', geocode: '10009010', days,
  })), async () => {
    assertForecastMatchesDay(await getWeather('雲林縣斗六市', 'today'), days[0], 'filled day');

    for (const [index, time] of [[1, 'tomorrow'], [2, 'day_after_tomorrow']]) {
      const weather = await getWeather('雲林縣斗六市', time);
      assert.equal(weather.description, days[index].weather, time);
      assert.equal(weather.tempMin, '無資料', time);
      assert.equal(weather.tempMax, '無資料', time);
      assert.equal(weather.feelsLike, '無資料', time);
      assert.equal(weather.humidity, '無資料', time);
      assert.equal(weather.windSpeed, '無資料', time);
      assert.equal(weather.windDirection, null, time);
      assert.equal(weather.pop, null, time);
      assert.equal(weather.popRaw, null, time);
      assert.equal(weather.tempMinRaw, null, time);
      assert.equal(weather.tempMaxRaw, null, time);
    }

    // After the date and the forecast text, each line shows the range and the rain chance.
    const week = await getWeather('雲林縣斗六市', 'week');
    assert.deepEqual(week.weekSummary.split('\n').map((line) => line.split('，').slice(1).join('，')), [
      '22°C～29°C，降雨機率 40%',
      '無資料～無資料，降雨機率無資料',
      '無資料～無資料，降雨機率無資料',
    ]);
    assert.doesNotMatch(week.weekSummary, /降雨機率 0%|0°C/);
  });
});

test('every kind of blank CWA value is no data, never 0', () => {
  for (const blank of ['', ' ', '\t', '\n', ' \r\n ', ' ', '　']) {
    const [day] = dailyCwaForecast(officialWeekLocation({
      name: '西區', geocode: '66000040', days: [{ ...forecastDays()[0], blank }],
    }));
    const label = JSON.stringify(blank);
    assert.equal(day.min, null, label);
    assert.equal(day.max, null, label);
    assert.equal(day.pop, null, label);
    assert.equal(day.apparent, undefined, label);
    assert.equal(day.humidity, undefined, label);
    assert.equal(day.windSpeed, undefined, label);
    assert.equal(day.windDirection, undefined, label);
  }

  // Padding around a real number is still read.
  const start = `${taiwanDate(0)}T06:00:00+08:00`;
  const [padded] = dailyCwaForecast({
    WeatherElement: [
      { ElementName: '最高溫度', Time: [{ StartTime: start, ElementValue: [{ MaxTemperature: ' 29 ' }] }] },
      { ElementName: '12小時降雨機率', Time: [{ StartTime: start, ElementValue: [{ ProbabilityOfPrecipitation: '\t0\n' }] }] },
    ],
  });
  assert.equal(padded.max, 29);
  assert.equal(padded.pop, 0, 'a real 0% rain chance stays 0');
});
