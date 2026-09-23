const OPENWEATHER_URL = 'https://api.openweathermap.org/data/2.5/weather';
const FORECAST_URL = 'https://api.openweathermap.org/data/2.5/forecast';

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
    throw new WeatherError('尚未設定 OPENWEATHER_API_KEY。', 'missing_api_key');
  }

  return apiKey;
}

function formatTemperature(value) {
  return `${Math.round(value)}°C`;
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
      'OpenWeather API key 無效或尚未啟用。請確認 .env 的 OPENWEATHER_API_KEY 是有效 key，儲存後重新啟動小吉；新 key 有時需要等待幾分鐘才會生效。',
      'unauthorized'
    );
  }

  if (response.status === 404) {
    throw new WeatherError(`找不到城市：${normalizedCity}`, 'city_not_found');
  }

  if (!response.ok) {
    throw new WeatherError(`OpenWeather 回應錯誤：HTTP ${response.status}`, 'provider_error');
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
    popRaw,
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
    weekSummary: days.join('\n'),
  };
}

async function getWeather(city, time = 'today') {
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
};
