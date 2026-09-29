const test = require('node:test');
const assert = require('node:assert/strict');
const { getWeather, WeatherError } = require('../src/services/weatherService');
const {
  normalizeWeatherCommandLocation,
  parseWeatherQuery,
  TAIWAN_DISTRICTS,
} = require('../src/utils/weatherNLP');

test('Taiwan districts resolve to their county and district for a weather query', () => {
  for (const { county, district } of TAIWAN_DISTRICTS) {
    const location = `${county}${district}`;
    const resolved = normalizeWeatherCommandLocation(location);
    assert.equal(resolved.city, county, location);
    assert.equal(resolved.district, district, location);
    assert.equal(resolved.location, location);
    assert.equal(resolved.invalid, null);
  }

  const question = parseWeatherQuery('請問明天台北市大安區天氣如何？');
  assert.equal(question.location, '臺北市大安區');
  assert.equal(question.time, 'tomorrow');
});

test('an unknown district receives a clear public correction prompt', async () => {
  await assert.rejects(getWeather('臺北市不存在區'), (error) =>
    error instanceof WeatherError &&
    error.code === 'city_not_found' &&
    error.message === '請提供正確的縣市及行政區名稱。');
});
