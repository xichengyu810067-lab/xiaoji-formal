const OPENWEATHER_URL = 'https://api.openweathermap.org/data/2.5/weather';
const FORECAST_URL = 'https://api.openweathermap.org/data/2.5/forecast';
const {
  resolveOverseasCityName,
  resolveTaiwanEnglishName,
  resolveWeatherLocation,
  normalizeTaiwanName,
  TAIWAN_DISTRICTS,
} = require('../utils/weatherNLP');
const logger = require('../utils/logger');

// Fixed reply when city is not found, shared by slash command and AI chat path
const CITY_NOT_FOUND_MESSAGE = '我找不到這個地名的天氣資料。請試著補上縣市與行政區，例如：臺北市大同區天氣。';
// Footers for OpenWeather replies, so a reply always says where its data came from.
const OPENWEATHER_CURRENT_LABEL = 'OpenWeather 即時天氣';
const OPENWEATHER_FORECAST_LABEL = 'OpenWeather 預報';

// CWA's official county-level seven-day forecast datasets.
// https://opendata.cwa.gov.tw/dist/opendata-swagger.html
const CWA_WEEK_DATASETS = {
  宜蘭縣: 'F-D0047-003', 桃園市: 'F-D0047-007', 新竹縣: 'F-D0047-011',
  苗栗縣: 'F-D0047-015', 彰化縣: 'F-D0047-019', 南投縣: 'F-D0047-023',
  雲林縣: 'F-D0047-027', 嘉義縣: 'F-D0047-031', 屏東縣: 'F-D0047-035',
  臺東縣: 'F-D0047-039', 花蓮縣: 'F-D0047-043', 澎湖縣: 'F-D0047-047',
  基隆市: 'F-D0047-051', 新竹市: 'F-D0047-055', 嘉義市: 'F-D0047-059',
  臺北市: 'F-D0047-063', 高雄市: 'F-D0047-067', 新北市: 'F-D0047-071',
  臺中市: 'F-D0047-075', 臺南市: 'F-D0047-079', 連江縣: 'F-D0047-083',
  金門縣: 'F-D0047-087',
};
const CWA_ALL_COUNTIES_WEEK = 'F-D0047-091';
const cwaCache = new Map();

class WeatherError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WeatherError';
    this.code = code;
  }
}

// Said when the forecast has no entry for the day (or days) that was asked for.
const FORECAST_UNAVAILABLE_MESSAGE = '該日期目前沒有可用的預報。';

// Safe identifier of an error for the log: letters, digits, and underscores only,
// so a URL, query string, or key can never be written. The string code of the
// network cause (ECONNRESET, ETIMEDOUT, ...) wins, then the string code of the
// error itself, then its name (TimeoutError, AbortError, ...), then a numeric
// code. A DOMException has a legacy numeric code (20, 23), so its name must come
// before any numeric code.
const SAFE_ERROR_CODE = /^\w{1,64}$/;
function safeErrorCode(error) {
  const candidates = [
    typeof error?.cause?.code === 'string' ? error.cause.code : null,
    typeof error?.code === 'string' ? error.code : null,
    error?.name,
    Number.isInteger(error?.code) ? error.code : null,
  ];
  for (const candidate of candidates) {
    // Only strings and numbers are stringified, so a hostile object cannot throw here.
    const text = typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : '';
    if (SAFE_ERROR_CODE.test(text)) return text;
  }
  return 'unknown';
}

function requireWeatherApiKey() {
  const apiKey = process.env.OPENWEATHER_API_KEY;

  if (!apiKey) {
    throw new WeatherError('天氣資料暫時無法查詢，請稍後再試。', 'missing_api_key');
  }

  return apiKey;
}

function formatTemperature(value) {
  const number = numericValue(value);
  return number === null ? '無資料' : `${Math.round(number)}°C`;
}

function formatOptionalTemperature(value) {
  return value == null ? '無資料' : formatTemperature(value);
}

function numericValue(value) {
  // Number(" ") is 0, so a blank string must be ruled out before converting.
  const text = typeof value === 'string' ? value.trim() : value;
  if (text === '' || text == null || text === '-') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function field(object, ...names) {
  if (!object || typeof object !== 'object') return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(object, name)) return object[name];
  }
  return undefined;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function firstValue(time, names) {
  const item = asArray(field(time, 'ElementValue', 'elementValue'))[0];
  return field(item, ...names, 'Value', 'value') ?? null;
}

function windValues(time) {
  const values = asArray(field(time, 'ElementValue', 'elementValue'));
  let direction = null;
  let speed = null;
  for (const item of values) {
    const namedDirection = field(item, 'WindDirection', 'windDirection');
    const namedSpeed = numericValue(field(item, 'WindSpeed', 'windSpeed'));
    const directionText = String(namedDirection ?? '').trim();
    if (directionText && directionText !== '-') direction = directionText;
    if (namedSpeed !== null) speed = namedSpeed;

    const value = String(field(item, 'Value', 'value') || '').trim();
    const unit = String(field(item, 'Measures', 'measures') || '').toLowerCase();
    if (!value || value === '-') continue;
    if (/公尺\/秒|m\/s/.test(unit)) speed = numericValue(value);
    else if (/風向|方位/.test(unit)) direction = value;
  }
  // Some responses omit measures; a numeric value is speed, text is direction.
  if (direction === null && speed === null) {
    for (const item of values) {
      const value = String(item?.value || '').trim();
      if (!value || value === '-') continue;
      const numeric = numericValue(value);
      if (numeric !== null && speed === null) speed = numeric;
      else if (numeric === null && direction === null) direction = value;
    }
  }
  return { direction, speed };
}

function parseCwaTime(value) {
  if (value instanceof Date) return value;
  const text = String(value || '');
  // CWA JSON may omit the offset while still expressing Taiwan local time.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    return new Date(`${text.replace(' ', 'T')}+08:00`);
  }
  return new Date(text);
}

function dayKey(value) {
  const date = parseCwaTime(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const field = (name) => parts.find((part) => part.type === name)?.value;
  return `${field('year')}-${field('month')}-${field('day')}`;
}

// The Taiwan calendar days (YYYY-MM-DD) a "weekend" question is about: this week's Saturday and
// Sunday, or only the one of them that has not passed yet (just Sunday on a Sunday).
function weekendDayKeys(now = new Date()) {
  const today = dayKey(now);
  const todayStart = Date.parse(`${today}T00:00:00Z`);
  const weekday = new Date(todayStart).getUTCDay(); // 0 is Sunday, 6 is Saturday
  const daysToSaturday = weekday === 0 ? -1 : 6 - weekday;
  return [daysToSaturday, daysToSaturday + 1]
    .map((offset) => new Date(todayStart + offset * 86400000).toISOString().slice(0, 10))
    .filter((key) => key >= today);
}

// Forecast field -> accepted ElementName values -> accepted ElementValue keys.
// F-D0047 payloads come in two naming generations and both are accepted:
//   - Current: Chinese ElementName values enumerated by the official swagger
//     (https://opendata.cwa.gov.tw/apidoc/v1). All one-week datasets
//     (F-D0047-003 ... 091) expose 12小時降雨機率, 平均相對濕度, 最高溫度, 最低溫度,
//     最高體感溫度, 風速, 風向, 天氣現象 and 天氣預報綜合描述; the three-day datasets
//     expose 3小時降雨機率, 相對濕度, 體感溫度, 風速 and 風向. Wind speed and wind
//     direction are two separate elements that are merged per day below.
//   - Legacy: English factor codes from the official factor table
//     (https://opendata.cwa.gov.tw/opendatadoc/Forecast/ForecastElement.pdf), where
//     Wind (風向風速) is one combined element; the same table also lists WD (風向)
//     and WS (風速) as separate factors.
// The English ElementValue keys of the current format are not documented in the
// public CWA documents; they still need confirmation against a live response.
// Wind keys are read by windValues(), so the wind rows carry no value keys.
const CWA_FORECAST_FIELDS = [
  ['description', ['Wx', '天氣現象', 'WeatherDescription', '天氣預報綜合描述'], ['WeatherDescription', 'Weather']],
  ['min', ['MinT', '最低溫度'], ['MinTemperature', 'Temperature']],
  ['max', ['MaxT', '最高溫度'], ['MaxTemperature', 'Temperature']],
  ['apparent', ['MaxAT', '最高體感溫度', 'AT', '體感溫度'], ['MaxApparentTemperature', 'ApparentTemperature']],
  ['humidity', ['RH', '相對濕度', '平均相對濕度'], ['RelativeHumidity']],
  ['wind', ['Wind', '風向風速'], []],
  ['windSpeed', ['WS', '風速'], []],
  ['windDirection', ['WD', '風向'], []],
  ['pop', ['PoP', 'PoP12h', 'PoP6h', '降雨機率', '3小時降雨機率', '12小時降雨機率'], ['ProbabilityOfPrecipitation']],
];

// Tolerate full-width digits, stray spaces, and letter case in ElementName.
function normalizeElementName(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function elementIntervals(location, names) {
  const wanted = new Set(names.map(normalizeElementName));
  const elements = asArray(field(location, 'WeatherElement', 'weatherElement'));
  const element = elements.find((item) => wanted.has(normalizeElementName(field(item, 'ElementName', 'elementName'))));
  return asArray(field(element, 'Time', 'time'));
}

function dailyCwaForecast(location) {
  const byDay = new Map();
  for (const [forecastField, names, valueNames] of CWA_FORECAST_FIELDS) {
    for (const interval of elementIntervals(location, names)) {
      const key = dayKey(field(interval, 'StartTime', 'startTime', 'DataTime', 'dataTime'));
      if (!key) continue;
      const item = byDay.get(key) || { date: key, min: null, max: null, pop: null };
      const value = firstValue(interval, valueNames);
      if (forecastField === 'wind' || forecastField === 'windSpeed' || forecastField === 'windDirection') {
        // A split element contributes only its own half, so whatever windValues()
        // guesses for the other half is dropped. BeaufortScale is never read, so a
        // Beaufort level cannot be shown as m/s.
        const wind = windValues(interval);
        if (forecastField !== 'windSpeed' && wind.direction && !item.windDirection) item.windDirection = wind.direction;
        if (forecastField !== 'windDirection' && wind.speed !== null && item.windSpeed == null) item.windSpeed = wind.speed;
      } else if (['min', 'max', 'apparent', 'humidity', 'pop'].includes(forecastField)) {
        const number = numericValue(value);
        if (number !== null) {
          if (forecastField === 'min') item.min = item.min === null ? number : Math.min(item.min, number);
          else if (forecastField === 'max') item.max = item.max === null ? number : Math.max(item.max, number);
          else if (forecastField === 'pop') item.pop = item.pop === null ? number : Math.max(item.pop, number);
          else item[forecastField] = number;
        }
      } else if (value && value !== '-' && !item[forecastField]) {
        item[forecastField] = String(value);
      }
      byDay.set(key, item);
    }
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 7);
}

async function fetchCwaDataset(datasetId) {
  const cached = cwaCache.get(datasetId);
  if (cached && cached.expires > Date.now()) return cached.data;
  const key = process.env.CWA_API_KEY;
  if (!key) throw new WeatherError('臺灣天氣資料暫時無法查詢，請稍後再試。', 'missing_api_key');
  const url = new URL(`https://opendata.cwa.gov.tw/api/v1/rest/datastore/${datasetId}`);
  url.searchParams.set('format', 'JSON');
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: key },
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
  } catch (error) {
    // The public class stays generic; the log keeps a safe root-cause code.
    logger.warn(`CWA request failed: ${safeErrorCode(error)}`);
    throw new WeatherError('臺灣天氣資料暫時無法查詢，請稍後再試。', 'provider_error');
  }
  if (response.status === 401 || response.status === 403) {
    throw new WeatherError('臺灣天氣資料暫時無法查詢，請稍後再試。', 'unauthorized');
  }
  if (response.status === 429) {
    throw new WeatherError('臺灣天氣資料暫時無法查詢，請稍後再試。', 'rate_limited');
  }
  if (!response.ok) {
    throw new WeatherError('臺灣天氣資料暫時無法查詢，請稍後再試。', 'provider_error');
  }
  let data;
  try {
    data = await response.json();
  } catch (error) {
    logger.warn(`CWA response unreadable: ${safeErrorCode(error)}`);
    throw new WeatherError('臺灣天氣資料暫時無法查詢，請稍後再試。', 'invalid_response');
  }
  const success = field(data, 'success', 'Success');
  if (success === false || String(success).toLowerCase() === 'false') {
    throw new WeatherError('臺灣天氣資料暫時無法查詢，請稍後再試。', 'provider_error');
  }
  const records = field(data, 'records', 'Records');
  const groups = asArray(field(records, 'Locations', 'locations'));
  if (!groups.length) {
    throw new WeatherError('目前查不到這個地點的天氣資料，請稍後再試。', 'empty_response');
  }
  cwaCache.set(datasetId, { data, expires: Date.now() + 15 * 60 * 1000 });
  return data;
}

async function getTaiwanWeather(resolved, time) {
  const datasetId = resolved.district
    ? CWA_WEEK_DATASETS[resolved.city]
    : CWA_ALL_COUNTIES_WEEK;
  const data = await fetchCwaDataset(datasetId);
  const records = field(data, 'records', 'Records');
  const groups = asArray(field(records, 'Locations', 'locations'));
  const targetName = resolved.district || resolved.city;
  const matchesName = (actual, expected) => normalizeTaiwanName(actual) === normalizeTaiwanName(expected);
  const districtCode = resolved.district
    ? TAIWAN_DISTRICTS.find((entry) => entry.county === resolved.city && entry.district === resolved.district)?.districtCode
    : null;
  const matchesLocation = (item) => (
    (districtCode && String(field(item, 'Geocode', 'geocode') || '') === districtCode)
    || matchesName(field(item, 'LocationName', 'locationName'), targetName)
  );
  const groupLocations = (entry) => asArray(field(entry, 'Location', 'location'));
  const group = groups.find((entry) => matchesName(field(entry, 'LocationsName', 'locationsName'), resolved.city))
    || groups.find((entry) => groupLocations(entry).some(matchesLocation))
    || (resolved.district && groups.length === 1 ? groups[0] : null);
  const location = groupLocations(group).find(matchesLocation);
  if (!location) {
    throw new WeatherError('目前查不到這個地點的天氣資料，請稍後再試。', 'empty_response');
  }
  const days = dailyCwaForecast(location);
  if (!days.length) throw new WeatherError('目前查不到這個地點的天氣資料，請稍後再試。', 'empty_response');
  const groupDatasetInfo = field(group, 'DatasetInfo', 'datasetInfo');
  const recordsDatasetInfo = field(records, 'DatasetInfo', 'datasetInfo');
  const issuedAt = field(groupDatasetInfo, 'IssueTime', 'issueTime')
    || field(recordsDatasetInfo, 'IssueTime', 'issueTime')
    || null;
  const issueDate = issuedAt ? parseCwaTime(issuedAt) : null;
  // No public CWA document names an issue time for the current F-D0047 JSON (the
  // swagger lists IssueTime only for the F-A0085 and M-A0085 datasets), so a
  // payload without one is labelled with its source alone instead of a notice.
  const sourceLabel = issueDate && !Number.isNaN(issueDate.getTime())
    ? `中央氣象署預報，發布於 ${issueDate.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}（台灣時間）`
    : '中央氣象署預報';
  if (time === 'week' || time === 'weekend') {
    let listed = days;
    if (time === 'weekend') {
      const weekend = new Set(weekendDayKeys());
      listed = days.filter((day) => weekend.has(day.date));
      if (!listed.length) throw new WeatherError(FORECAST_UNAVAILABLE_MESSAGE, 'forecast_unavailable');
    }
    return {
      city: resolved.location, isWeek: true, forecastDays: listed.length,
      source: 'cwa', sourceLabel,
      weekSummary: listed.map((day) => {
        const rain = day.pop === null ? '降雨機率無資料' : `降雨機率 ${day.pop}%`;
        return `${day.date.slice(5).replace('-', '/')}：${day.description || '天氣狀況無資料'}，${formatOptionalTemperature(day.min)}～${formatOptionalTemperature(day.max)}，${rain}`;
      }).join('\n'),
    };
  }
  const offset = time === 'tomorrow' ? 1 : time === 'day_after_tomorrow' ? 2 : 0;
  const today = dayKey(new Date());
  const target = dayKey(new Date(new Date(today + 'T00:00:00+08:00').getTime() + offset * 86400000));
  const day = days.find((entry) => entry.date === target);
  if (!day) throw new WeatherError(FORECAST_UNAVAILABLE_MESSAGE, 'forecast_unavailable');
  return {
    city: resolved.location, description: day.description || '天氣狀況無資料',
    temperature: formatOptionalTemperature(day.max),
    tempMin: formatOptionalTemperature(day.min),
    tempMax: formatOptionalTemperature(day.max),
    feelsLike: formatOptionalTemperature(day.apparent ?? null),
    humidity: day.humidity == null ? '無資料' : `${day.humidity}%`,
    windSpeed: day.windSpeed == null ? '無資料' : `${day.windSpeed} m/s`,
    windDirection: day.windDirection || null,
    pop: day.pop == null ? null : `${day.pop}%`,
    tempMinRaw: day.min, tempMaxRaw: day.max, popRaw: day.pop,
    forecastPeriod: day.date, source: 'cwa', sourceLabel,
  };
}

function getApiLocationMapping() {
  return {
    '新北市新莊區': '新莊區',
    '新北市板橋區': '板橋區',
    '新北市中和區': '中和區',
    '新北市永和區': '永和區',
    '新北市三重區': '三重區',
    '新北市土城區': '土城區',
    '新北市淡水區': '淡水區',
    '新竹縣竹北市': 'Zhubei, TW',
    '竹北市': 'Zhubei, TW',
    '桃園市中壢區': '中壢區',
    '中壢區': 'Zhongli District, Taoyuan, TW',
    '臺北市士林區': '士林區',
    '臺北市信義區': '信義區',
    '高雄市左營區': '左營區',
    '高雄市鳳山區': '鳳山區',
    '臺南市東區': 'East District, Tainan',
    '新竹市東區': 'East District, Hsinchu',
    '嘉義市東區': 'East District, Chiayi',
    '臺中市東區': 'East District, Taichung',
  };
}

async function fetchWeatherApi(url, city) {
  const apiKey = requireWeatherApiKey();
  const normalizedCity = String(city || '').trim();

  if (!normalizedCity) {
    throw new WeatherError('請輸入城市名稱。', 'missing_city');
  }

  const mapping = getApiLocationMapping();
  const searchCity = mapping[normalizedCity] || normalizedCity;
  
  url.searchParams.set('q', searchCity);
  url.searchParams.set('appid', apiKey);
  url.searchParams.set('units', 'metric');
  url.searchParams.set('lang', 'zh_tw');

  const response = await fetch(url);

  if (response.status === 401) {
    throw new WeatherError(
      '天氣資料暫時無法查詢，請稍後再試。',
      'unauthorized'
    );
  }

  if (response.status === 404) {
    throw new WeatherError(CITY_NOT_FOUND_MESSAGE, 'city_not_found');
  }

  if (!response.ok) {
    throw new WeatherError('天氣資料暫時無法查詢，請稍後再試。', 'provider_error');
  }

  return await response.json();
}

async function getCurrentWeather(city) {
  const url = new URL(OPENWEATHER_URL);
  const data = await fetchWeatherApi(url, city);
  const weather = data.weather?.[0];
  const tempMinRaw = numericValue(data.main?.temp_min);
  const tempMaxRaw = numericValue(data.main?.temp_max);

  return {
    city: `${data.name}${data.sys?.country ? `, ${data.sys.country}` : ''}`,
    description: weather?.description || '未知',
    temperature: formatTemperature(data.main?.temp),
    tempMin: formatTemperature(tempMinRaw),
    tempMax: formatTemperature(tempMaxRaw),
    feelsLike: formatTemperature(data.main?.feels_like),
    humidity: numericValue(data.main?.humidity) === null ? '無資料' : `${data.main.humidity}%`,
    windSpeed: numericValue(data.wind?.speed) === null ? '無資料' : `${data.wind.speed} m/s`,
    pop: null, // Current weather API doesn't return pop
    tempMinRaw,
    tempMaxRaw,
    popRaw: null,
    source: 'openweather',
    sourceLabel: OPENWEATHER_CURRENT_LABEL,
  };
}

async function getForecastWeather(city, time) {
  const url = new URL(FORECAST_URL);
  const data = await fetchWeatherApi(url, city);
  
  let targetOffset = 0;
  if (time === 'tomorrow') targetOffset = 1;
  else if (time === 'day_after_tomorrow') targetOffset = 2;
  else if (time === 'this_week') targetOffset = 1;

  const now = new Date();
  const targetDate = new Date(now.getTime() + targetOffset * 24 * 60 * 60 * 1000);
  
  const twFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = twFormatter.formatToParts(targetDate);
  const tzDate = `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}`;

  // Get all data points for the target day
  const dailyData = data.list.filter(item => {
    const itemDate = new Date(item.dt * 1000);
    const itemParts = twFormatter.formatToParts(itemDate);
    const itemTzDate = `${itemParts.find(p=>p.type==='year').value}-${itemParts.find(p=>p.type==='month').value}-${itemParts.find(p=>p.type==='day').value}`;
    return itemTzDate === tzDate;
  });

  if (dailyData.length === 0) {
    const fallback = data.list[data.list.length - 1];
    if (!fallback) throw new WeatherError('天氣資料暫時無法查詢，請稍後再試。', 'provider_error');
    dailyData.push(fallback);
  }

  // Calculate daily aggregates
  const minValues = dailyData.map((item) => numericValue(item.main?.temp_min)).filter((value) => value !== null);
  const maxValues = dailyData.map((item) => numericValue(item.main?.temp_max)).filter((value) => value !== null);
  const popValues = dailyData.map((item) => numericValue(item.pop)).filter((value) => value !== null);
  const tempMinRaw = minValues.length ? Math.min(...minValues) : null;
  const tempMaxRaw = maxValues.length ? Math.max(...maxValues) : null;
  const popRaw = popValues.length ? Math.max(...popValues) : null;
  
  // Use noon or first item for description/current temp
  let targetForecast = dailyData.find(item => new Date(item.dt * 1000).getUTCHours() >= 4) || dailyData[0];
  const weather = targetForecast.weather?.[0];

  return {
    city: `${data.city.name}${data.city.country ? `, ${data.city.country}` : ''}`,
    description: weather?.description || '未知',
    temperature: formatTemperature(targetForecast.main?.temp),
    tempMin: formatTemperature(tempMinRaw),
    tempMax: formatTemperature(tempMaxRaw),
    feelsLike: formatTemperature(targetForecast.main?.feels_like),
    humidity: numericValue(targetForecast.main?.humidity) === null ? '無資料' : `${targetForecast.main.humidity}%`,
    windSpeed: numericValue(targetForecast.wind?.speed) === null ? '無資料' : `${targetForecast.wind.speed} m/s`,
    pop: popRaw === null ? null : `${Math.round(popRaw * 100)}%`,
    tempMinRaw,
    tempMaxRaw,
    popRaw: popRaw === null ? null : popRaw * 100,
    source: 'openweather',
    sourceLabel: OPENWEATHER_FORECAST_LABEL,
  };
}

// One OpenWeather forecast entry per Taiwan calendar day, in date order:
// YYYY-MM-DD -> { label: 'MM/DD', min, max, pop, desc }.
function openWeatherDailyStats(data) {
  const twFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });

  const daysMap = new Map();
  for (const item of data.list) {
    const itemDate = new Date(item.dt * 1000);
    const parts = twFormatter.formatToParts(itemDate);
    const part = (type) => parts.find((p) => p.type === type).value;
    const tzDate = `${part('year')}-${part('month')}-${part('day')}`;

    if (!daysMap.has(tzDate)) {
      daysMap.set(tzDate, {
        label: `${part('month')}/${part('day')}`,
        min: numericValue(item.main?.temp_min),
        max: numericValue(item.main?.temp_max),
        pop: numericValue(item.pop),
        desc: item.weather?.[0]?.description || '未知',
      });
    } else {
      const dayData = daysMap.get(tzDate);
      const min = numericValue(item.main?.temp_min);
      const max = numericValue(item.main?.temp_max);
      const pop = numericValue(item.pop);
      if (min !== null) dayData.min = dayData.min === null ? min : Math.min(dayData.min, min);
      if (max !== null) dayData.max = dayData.max === null ? max : Math.max(dayData.max, max);
      if (pop !== null) dayData.pop = dayData.pop === null ? pop : Math.max(dayData.pop, pop);
      // Prefer mid-day description
      if (itemDate.getUTCHours() >= 4 && itemDate.getUTCHours() <= 8) {
        dayData.desc = item.weather?.[0]?.description || dayData.desc;
      }
    }
  }
  return daysMap;
}

// The multi-day reply of an OpenWeather forecast, listing the given daily entries.
function openWeatherMultiDayWeather(data, listed) {
  const days = listed.map((stats) => {
    const rain = stats.pop === null ? '降雨率 無資料' : `降雨率 ${Math.round(stats.pop * 100)}%`;
    return `${stats.label}: ${stats.desc}, ${formatTemperature(stats.min)}~${formatTemperature(stats.max)}, ${rain}`;
  });

  return {
    city: `${data.city.name}${data.city.country ? `, ${data.city.country}` : ''}`,
    isWeek: true,
    forecastDays: days.length,
    weekSummary: days.join('\n'),
    source: 'openweather',
    sourceLabel: OPENWEATHER_FORECAST_LABEL,
  };
}

async function getWeekWeather(city) {
  const url = new URL(FORECAST_URL);
  const data = await fetchWeatherApi(url, city);
  return openWeatherMultiDayWeather(data, [...openWeatherDailyStats(data).values()].slice(0, 5));
}

// The weekend days the 5-day forecast reaches. A weekend it does not reach is not answered with
// another day.
async function getWeekendWeather(city) {
  const url = new URL(FORECAST_URL);
  const data = await fetchWeatherApi(url, city);
  const weekend = new Set(weekendDayKeys());
  const listed = [...openWeatherDailyStats(data)].filter(([date]) => weekend.has(date)).map(([, stats]) => stats);
  if (!listed.length) throw new WeatherError(FORECAST_UNAVAILABLE_MESSAGE, 'forecast_unavailable');
  return openWeatherMultiDayWeather(data, listed);
}

// The server's default /weather city, or null when it has none. guildConfig keeps it trimmed
// and capped at 100 characters. The settings store is required here and not at the top, so that
// loading the weather service never loads guildConfig before the retained data root is set.
function getDefaultCity(guildId) {
  const { getGuildConfig } = require('../utils/guildConfig');
  return getGuildConfig(guildId).weatherDefaultCity;
}

async function getWeather(city, time = 'today') {
  let resolved = resolveWeatherLocation(city);
  if (resolved.invalid || resolved.ambiguous) {
    throw new WeatherError('請提供正確的縣市及行政區名稱。', 'city_not_found');
  }
  // What OpenWeather is asked for. The Chinese name of an overseas city ("東京") is asked for
  // under its English name, which is the only one OpenWeather finds.
  let lookup = city;
  if (!resolved.city) {
    const overseasName = resolveOverseasCityName(resolved.location || city);
    if (overseasName) {
      lookup = overseasName;
      resolved = resolveWeatherLocation(overseasName);
    }
  }
  // With a CWA key, a Taiwan place typed (or saved as a server default in older versions) in
  // English, such as Hsinchu, is read from CWA under its Chinese name. Without one it keeps the
  // OpenWeather lookup it always had.
  if (!resolved.city && process.env.CWA_API_KEY) {
    const taiwanName = resolveTaiwanEnglishName(resolved.location || lookup);
    if (taiwanName) resolved = resolveWeatherLocation(taiwanName);
  }
  if (resolved.city) return getTaiwanWeather(resolved, time);
  if (time === 'week') {
    return getWeekWeather(lookup);
  }
  if (time === 'weekend') {
    return getWeekendWeather(lookup);
  }
  if (time === 'today') {
    return getCurrentWeather(lookup);
  }
  return getForecastWeather(lookup, time);
}

module.exports = {
  WeatherError,
  getCurrentWeather,
  getDefaultCity,
  getWeather,
  dailyCwaForecast,
  safeErrorCode,
  CWA_WEEK_DATASETS,
  CITY_NOT_FOUND_MESSAGE,
  FORECAST_UNAVAILABLE_MESSAGE,
  weekendDayKeys,
};
