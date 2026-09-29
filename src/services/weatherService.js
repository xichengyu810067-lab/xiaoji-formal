const OPENWEATHER_URL = 'https://api.openweathermap.org/data/2.5/weather';
const FORECAST_URL = 'https://api.openweathermap.org/data/2.5/forecast';
const { resolveWeatherLocation, normalizeTaiwanName, TAIWAN_DISTRICTS } = require('../utils/weatherNLP');

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

function requireWeatherApiKey() {
  const apiKey = process.env.OPENWEATHER_API_KEY;

  if (!apiKey) {
    throw new WeatherError('天氣資料暫時無法查詢，請稍後再試。', 'missing_api_key');
  }

  return apiKey;
}

function formatTemperature(value) {
  return `${Math.round(value)}°C`;
}

function formatOptionalTemperature(value) {
  return value === null ? '無資料' : formatTemperature(value);
}

function numericValue(value) {
  if (value === '' || value == null || value === '-') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstValue(time) {
  const item = Array.isArray(time?.elementValue) ? time.elementValue[0] : time?.elementValue;
  return item?.value ?? null;
}

function windValues(time) {
  const values = Array.isArray(time?.elementValue) ? time.elementValue : [];
  let direction = null;
  let speed = null;
  for (const item of values) {
    const value = String(item?.value || '').trim();
    const unit = String(item?.measures || '').toLowerCase();
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

function elementIntervals(location, names) {
  const element = location.weatherElement?.find((item) => names.includes(item.elementName));
  return Array.isArray(element?.time) ? element.time : [];
}

function dailyCwaForecast(location) {
  const byDay = new Map();
  const fields = [
    ['description', ['Wx', '天氣現象', 'WeatherDescription', '天氣預報綜合描述']],
    ['min', ['MinT', '最低溫度']],
    ['max', ['MaxT', '最高溫度']],
    ['apparent', ['MaxAT', '最高體感溫度', 'AT', '體感溫度']],
    ['humidity', ['RH', '相對濕度']],
    ['wind', ['Wind', '風向風速']],
    ['pop', ['PoP', 'PoP12h', '降雨機率']],
  ];
  for (const [field, names] of fields) {
    for (const interval of elementIntervals(location, names)) {
      const key = dayKey(interval.startTime || interval.dataTime);
      if (!key) continue;
      const item = byDay.get(key) || { date: key, min: null, max: null, pop: null };
      const value = firstValue(interval);
      if (field === 'wind') {
        const wind = windValues(interval);
        if (wind.direction && !item.windDirection) item.windDirection = wind.direction;
        if (wind.speed !== null && item.windSpeed == null) item.windSpeed = wind.speed;
      } else if (['min', 'max', 'apparent', 'humidity', 'pop'].includes(field)) {
        const number = numericValue(value);
        if (number !== null) {
          if (field === 'min') item.min = item.min === null ? number : Math.min(item.min, number);
          else if (field === 'max') item.max = item.max === null ? number : Math.max(item.max, number);
          else if (field === 'pop') item.pop = item.pop === null ? number : Math.max(item.pop, number);
          else item[field] = number;
        }
      } else if (value && value !== '-' && !item[field]) {
        item[field] = String(value);
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
  } catch {
    throw new WeatherError('臺灣天氣資料暫時無法查詢，請稍後再試。', 'provider_error');
  }
  if (!response.ok) {
    throw new WeatherError('臺灣天氣資料暫時無法查詢，請稍後再試。', 'provider_error');
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new WeatherError('臺灣天氣資料暫時無法查詢，請稍後再試。', 'provider_error');
  }
  if (String(data.success).toLowerCase() === 'false' || !Array.isArray(data.records?.locations)) {
    throw new WeatherError('臺灣天氣資料暫時無法查詢，請稍後再試。', 'provider_error');
  }
  cwaCache.set(datasetId, { data, expires: Date.now() + 15 * 60 * 1000 });
  return data;
}

async function getTaiwanWeather(resolved, time) {
  const datasetId = resolved.district
    ? CWA_WEEK_DATASETS[resolved.city]
    : CWA_ALL_COUNTIES_WEEK;
  const data = await fetchCwaDataset(datasetId);
  const groups = data.records.locations;
  const targetName = resolved.district || resolved.city;
  const matchesName = (actual, expected) => normalizeTaiwanName(actual) === expected;
  const districtCode = resolved.district
    ? TAIWAN_DISTRICTS.find((entry) => entry.county === resolved.city && entry.district === resolved.district)?.districtCode
    : null;
  const matchesLocation = (item) => (
    (districtCode && String(item.geocode || '') === districtCode)
    || matchesName(item.locationName, targetName)
  );
  const group = groups.find((entry) => matchesName(entry.locationsName, resolved.city))
    || groups.find((entry) => entry.location?.some(matchesLocation))
    || (resolved.district && groups.length === 1 ? groups[0] : null);
  const location = group?.location?.find(matchesLocation);
  if (!location) {
    throw new WeatherError('目前查不到這個地點的天氣資料，請稍後再試。', 'provider_error');
  }
  const days = dailyCwaForecast(location);
  if (!days.length) throw new WeatherError('目前查不到這個地點的天氣資料，請稍後再試。', 'provider_error');
  const issuedAt = group.datasetInfo?.issueTime || data.records.datasetInfo?.issueTime || null;
  const issueDate = issuedAt ? parseCwaTime(issuedAt) : null;
  const sourceLabel = issueDate && !Number.isNaN(issueDate.getTime())
    ? `中央氣象署預報，發布於 ${issueDate.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}（台灣時間）`
    : '中央氣象署預報（發布時間未提供）';
  if (time === 'week') {
    return {
      city: resolved.location, isWeek: true, forecastDays: days.length,
      sourceLabel,
      weekSummary: days.map((day) => {
        const rain = day.pop === null ? '降雨機率無資料' : `降雨機率 ${day.pop}%`;
        return `${day.date.slice(5).replace('-', '/')}：${day.description || '天氣狀況無資料'}，${formatOptionalTemperature(day.min)}～${formatOptionalTemperature(day.max)}，${rain}`;
      }).join('\n'),
    };
  }
  const offset = time === 'tomorrow' ? 1 : time === 'day_after_tomorrow' ? 2 : 0;
  const today = dayKey(new Date());
  const target = dayKey(new Date(new Date(today + 'T00:00:00+08:00').getTime() + offset * 86400000));
  const day = days.find((entry) => entry.date === target);
  if (!day) throw new WeatherError('該日期目前沒有可用的預報。', 'forecast_unavailable');
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
    forecastPeriod: day.date, sourceLabel,
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
    throw new WeatherError(`找不到城市：${normalizedCity}`, 'city_not_found');
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

  return {
    city: `${data.name}${data.sys?.country ? `, ${data.sys.country}` : ''}`,
    description: weather?.description || '未知',
    temperature: formatTemperature(data.main.temp),
    tempMin: formatTemperature(data.main.temp_min),
    tempMax: formatTemperature(data.main.temp_max),
    feelsLike: formatTemperature(data.main.feels_like),
    humidity: `${data.main.humidity}%`,
    windSpeed: `${data.wind?.speed ?? 0} m/s`,
    pop: null, // Current weather API doesn't return pop
    tempMinRaw: data.main.temp_min,
    tempMaxRaw: data.main.temp_max,
    popRaw: 0,
  };
}

async function getForecastWeather(city, time) {
  const url = new URL(FORECAST_URL);
  const data = await fetchWeatherApi(url, city);
  
  let targetOffset = 0;
  if (time === 'tomorrow') targetOffset = 1;
  else if (time === 'day_after_tomorrow') targetOffset = 2;
  else if (time === 'this_week' || time === 'weekend') targetOffset = 1; 

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
    dailyData.push(data.list[data.list.length - 1]); // fallback
  }

  // Calculate daily aggregates
  const tempMinRaw = Math.min(...dailyData.map(d => d.main.temp_min));
  const tempMaxRaw = Math.max(...dailyData.map(d => d.main.temp_max));
  const popRaw = Math.max(...dailyData.map(d => d.pop || 0));
  
  // Use noon or first item for description/current temp
  let targetForecast = dailyData.find(item => new Date(item.dt * 1000).getUTCHours() >= 4) || dailyData[0];
  const weather = targetForecast.weather?.[0];

  return {
    city: `${data.city.name}${data.city.country ? `, ${data.city.country}` : ''}`,
    description: weather?.description || '未知',
    temperature: formatTemperature(targetForecast.main.temp),
    tempMin: formatTemperature(tempMinRaw),
    tempMax: formatTemperature(tempMaxRaw),
    feelsLike: formatTemperature(targetForecast.main.feels_like),
    humidity: `${targetForecast.main.humidity}%`,
    windSpeed: `${targetForecast.wind?.speed ?? 0} m/s`,
    pop: `${Math.round(popRaw * 100)}%`,
    tempMinRaw,
    tempMaxRaw,
    popRaw: popRaw * 100,
  };
}

async function getWeekWeather(city) {
  const url = new URL(FORECAST_URL);
  const data = await fetchWeatherApi(url, city);
  
  const twFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
  
  const daysMap = new Map();
  for (const item of data.list) {
    const itemDate = new Date(item.dt * 1000);
    const parts = twFormatter.formatToParts(itemDate);
    const tzDate = `${parts.find(p=>p.type==='month').value}/${parts.find(p=>p.type==='day').value}`;
    
    if (!daysMap.has(tzDate)) {
      daysMap.set(tzDate, { min: item.main.temp_min, max: item.main.temp_max, pop: item.pop || 0, desc: item.weather?.[0]?.description || '未知' });
    } else {
      const dayData = daysMap.get(tzDate);
      dayData.min = Math.min(dayData.min, item.main.temp_min);
      dayData.max = Math.max(dayData.max, item.main.temp_max);
      dayData.pop = Math.max(dayData.pop, item.pop || 0);
      // Prefer mid-day description
      if (itemDate.getUTCHours() >= 4 && itemDate.getUTCHours() <= 8) {
        dayData.desc = item.weather?.[0]?.description || dayData.desc;
      }
    }
  }

  const days = Array.from(daysMap.entries()).slice(0, 5).map(([date, stats]) => {
    return `${date}: ${stats.desc}, ${formatTemperature(stats.min)}~${formatTemperature(stats.max)}, 降雨率 ${Math.round(stats.pop * 100)}%`;
  });

  return {
    city: `${data.city.name}${data.city.country ? `, ${data.city.country}` : ''}`,
    isWeek: true,
    forecastDays: days.length,
    weekSummary: days.join('\n'),
  };
}

async function getWeather(city, time = 'today') {
  const resolved = resolveWeatherLocation(city);
  if (resolved.invalid || resolved.ambiguous) {
    throw new WeatherError('請提供正確的縣市及行政區名稱。', 'city_not_found');
  }
  if (resolved.city) return getTaiwanWeather(resolved, time);
  if (time === 'week') {
    return getWeekWeather(city);
  }
  if (time === 'today') {
    return getCurrentWeather(city);
  }
  return getForecastWeather(city, time);
}

module.exports = {
  WeatherError,
  getCurrentWeather,
  getWeather,
  dailyCwaForecast,
  CWA_WEEK_DATASETS,
};
