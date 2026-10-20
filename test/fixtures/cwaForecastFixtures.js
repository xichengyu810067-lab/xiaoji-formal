'use strict';

// Synthetic CWA F-D0047 township forecast payloads for tests. They are written by
// hand: they are NOT real API responses and carry no authorization key.
//
// Structure source: the official swagger at https://opendata.cwa.gov.tw/apidoc/v1
// enumerates the ElementName values of every F-D0047 dataset; the two lists below
// are copied from it. The public CWA documents do not describe the English
// ElementValue keys (ProbabilityOfPrecipitation, WindSpeed, BeaufortScale, ...) or
// the legacy value/measures pairs, so those follow the review notes and the
// existing parser and still need confirmation against a live response.

// All 23 one-week datasets (F-D0047-003 ... 091) share this list.
const OFFICIAL_WEEK_ELEMENT_NAMES = Object.freeze([
  '最高溫度', '天氣預報綜合描述', '平均相對濕度', '最高體感溫度', '12小時降雨機率',
  '風向', '平均露點溫度', '最低體感溫度', '平均溫度', '最大舒適度指數',
  '最小舒適度指數', '風速', '紫外線指數', '天氣現象', '最低溫度',
]);

// All 23 three-day datasets (F-D0047-001 ... 089) share this list.
const OFFICIAL_THREE_HOUR_ELEMENT_NAMES = Object.freeze([
  '露點溫度', '天氣預報綜合描述', '舒適度指數', '風向', '3小時降雨機率',
  '溫度', '風速', '天氣現象', '相對濕度', '體感溫度',
]);

function addDays(date, count) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
}

// The one-week datasets publish a day window (06:00-18:00) and a night window
// (18:00-06:00) for every forecast day.
function twelveHourWindows(days, pickValue, { lowercase = false } = {}) {
  const names = lowercase
    ? { start: 'startTime', end: 'endTime', value: 'elementValue' }
    : { start: 'StartTime', end: 'EndTime', value: 'ElementValue' };
  return days.flatMap((day) => [
    {
      [names.start]: `${day.date}T06:00:00+08:00`,
      [names.end]: `${day.date}T18:00:00+08:00`,
      [names.value]: pickValue(day, 0),
    },
    {
      [names.start]: `${day.date}T18:00:00+08:00`,
      [names.end]: `${addDays(day.date, 1)}T06:00:00+08:00`,
      [names.value]: pickValue(day, 1),
    },
  ]);
}

// One forecast day looks like:
// { date, weather, description, min, max, apparentMax, humidity,
//   windSpeed, beaufort, windDirection, pop: [dayWindow, nightWindow] }
// `missing` marks every numeric and wind value with "-", which is how the feed
// reports a value that is not available. A day may instead carry `blank`, a
// placeholder such as " " that replaces each numeric and wind value of that day
// only, as when the last days of a week come back empty.
function officialWeekLocation({ name, geocode, days, missing = false }) {
  const text = (value, day) => (missing ? '-' : day?.blank ?? String(value));
  const element = (ElementName, pickValue) => ({
    ElementName,
    Time: twelveHourWindows(days, (day, part) => [pickValue(day, part)]),
  });
  return {
    LocationName: name,
    Geocode: geocode,
    Latitude: '24.14',
    Longitude: '120.66',
    WeatherElement: [
      element('平均溫度', (day) => ({ Temperature: text(Math.round((day.min + day.max) / 2), day) })),
      element('平均露點溫度', (day) => ({ DewPoint: text(day.min - 3, day) })),
      element('平均相對濕度', (day) => ({ RelativeHumidity: text(day.humidity, day) })),
      // The day window carries the high and the night window the low, so the
      // daily range must be rebuilt from both windows.
      element('最高溫度', (day, part) => ({ MaxTemperature: text(part === 0 ? day.max : day.max - 3, day) })),
      element('最低溫度', (day, part) => ({ MinTemperature: text(part === 0 ? day.min + 1 : day.min, day) })),
      element('最高體感溫度', (day) => ({ MaxApparentTemperature: text(day.apparentMax, day) })),
      element('最低體感溫度', (day) => ({ MinApparentTemperature: text(day.min - 1, day) })),
      element('最大舒適度指數', (day) => ({ MaxComfortIndex: text(26, day), MaxComfortIndexDescription: '舒適' })),
      element('最小舒適度指數', (day) => ({ MinComfortIndex: text(24, day), MinComfortIndexDescription: '舒適' })),
      element('12小時降雨機率', (day, part) => ({ ProbabilityOfPrecipitation: text(day.pop[part], day) })),
      // Wind speed and wind direction are two independent elements. BeaufortScale
      // is a wind level, not metres per second.
      element('風速', (day) => ({ WindSpeed: text(day.windSpeed, day), BeaufortScale: text(day.beaufort, day) })),
      element('風向', (day) => ({ WindDirection: text(day.windDirection, day) })),
      element('紫外線指數', (day) => ({ UVIndex: text(8, day), UVExposureLevel: '高量級' })),
      element('天氣現象', (day) => ({ Weather: day.weather, WeatherCode: '03' })),
      element('天氣預報綜合描述', (day) => ({ WeatherDescription: day.description })),
    ],
  };
}

function officialWeekResponse({ county, district, geocode, days, locationsName = county, missing = false }) {
  return {
    success: 'true',
    records: {
      Locations: [{
        DatasetDescription: '臺灣各鄉鎮市區預報資料',
        LocationsName: locationsName,
        Location: [officialWeekLocation({ name: district, geocode, days, missing })],
      }],
    },
  };
}

// A three-day (3-hour) location for one day. Instantaneous elements use DataTime;
// the rain chance and the weather phenomenon use StartTime/EndTime. Only the rain
// chance varies inside the day, so the result does not depend on which time step
// a humidity, wind, or apparent-temperature reader keeps.
function officialThreeHourLocation({ name, geocode, day }) {
  const hours = [6, 12, 18];
  const stamp = (hour) => `${day.date}T${String(hour).padStart(2, '0')}:00:00+08:00`;
  const instant = (ElementName, value) => ({
    ElementName,
    Time: hours.map((hour) => ({ DataTime: stamp(hour), ElementValue: [value] })),
  });
  const interval = (ElementName, pickValue) => ({
    ElementName,
    Time: hours.map((hour, index) => ({
      StartTime: stamp(hour),
      EndTime: stamp(hour + 3),
      ElementValue: [pickValue(index)],
    })),
  });
  return {
    LocationName: name,
    Geocode: geocode,
    WeatherElement: [
      instant('溫度', { Temperature: String(day.max) }),
      instant('露點溫度', { DewPoint: String(day.min) }),
      instant('相對濕度', { RelativeHumidity: String(day.humidity) }),
      instant('體感溫度', { ApparentTemperature: String(day.apparentMax) }),
      instant('舒適度指數', { ComfortIndex: '25', ComfortIndexDescription: '舒適' }),
      instant('風速', { WindSpeed: String(day.windSpeed), BeaufortScale: String(day.beaufort) }),
      instant('風向', { WindDirection: day.windDirection }),
      interval('3小時降雨機率', (index) => ({ ProbabilityOfPrecipitation: String(day.pop[index]) })),
      interval('天氣現象', () => ({ Weather: day.weather, WeatherCode: '03' })),
      interval('天氣預報綜合描述', () => ({ WeatherDescription: day.description })),
    ],
  };
}

// Pre-2024 shape: English factor codes, lowercase keys, and value/measures pairs.
// `wind` is "combined" for the single Wind (風向風速) element or "split" for the
// WD (風向) / WS (風速) pair. The code list follows the official factor table at
// https://opendata.cwa.gov.tw/opendatadoc/Forecast/ForecastElement.pdf.
function legacyWeekResponse({ county, district, geocode, days, wind = 'combined' }) {
  const element = (elementName, pickValue) => ({
    elementName,
    time: twelveHourWindows(days, (day, part) => pickValue(day, part), { lowercase: true }),
  });
  const percent = (value) => [{ value: String(value), measures: '百分比' }];
  const celsius = (value) => [{ value: String(value), measures: '攝氏度' }];
  const windElements = wind === 'split'
    ? [
      element('WD', (day) => [{ value: day.windDirection, measures: '八方位' }]),
      element('WS', (day) => [
        { value: String(day.windSpeed), measures: '公尺/秒' },
        { value: String(day.beaufort), measures: '蒲福風級' },
      ]),
    ]
    : [element('Wind', (day) => [
      { value: day.windDirection, measures: '風向' },
      { value: String(day.windSpeed), measures: '公尺/秒' },
      { value: String(day.beaufort), measures: '蒲福風級' },
    ])];
  return {
    success: true,
    records: {
      locations: [{
        locationsName: county,
        location: [{
          locationName: district,
          geocode,
          weatherElement: [
            element('Wx', (day) => [
              { value: day.weather, measures: '自定義 Wx 文字' },
              { value: '03', measures: '自定義 Wx 單位' },
            ]),
            element('MinT', (day, part) => celsius(part === 0 ? day.min + 1 : day.min)),
            element('MaxT', (day, part) => celsius(part === 0 ? day.max : day.max - 3)),
            element('MaxAT', (day) => celsius(day.apparentMax)),
            element('RH', (day) => percent(day.humidity)),
            ...windElements,
            element('PoP12h', (day, part) => percent(day.pop[part])),
          ],
        }],
      }],
    },
  };
}

module.exports = {
  OFFICIAL_THREE_HOUR_ELEMENT_NAMES,
  OFFICIAL_WEEK_ELEMENT_NAMES,
  legacyWeekResponse,
  officialThreeHourLocation,
  officialWeekLocation,
  officialWeekResponse,
};
