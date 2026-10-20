const {
  WeatherError,
  getDefaultCity,
  getWeather,
  safeErrorCode,
  CITY_NOT_FOUND_MESSAGE,
  FORECAST_UNAVAILABLE_MESSAGE,
} = require('../services/weatherService');
const { normalizeWeatherCommandLocation, parseWeatherQuery } = require('../utils/weatherNLP');
const { recordPublicInteraction } = require('../services/publicStatusService');
const logger = require('../utils/logger');

function getAdvice(weather) {
  const advice = [];

  if (weather.tempMaxRaw !== null && weather.tempMaxRaw >= 30) {
    advice.push('天氣炎熱，請注意防曬並多補充水分');
  } else if (weather.tempMinRaw !== null && weather.tempMinRaw <= 15) {
    advice.push('天氣偏冷，出門請記得穿暖一點');
  } else if (weather.tempMinRaw !== null && weather.tempMaxRaw !== null) {
    advice.push('氣溫舒適，出門保持一般準備就可以');
  }

  if (weather.popRaw > 40) {
    advice.push('降雨機率偏高，建議帶傘');
  } else if (weather.popRaw > 10) {
    advice.push('有一點降雨機率，可以視情況帶傘');
  }

  return advice.length ? `${advice.join('，')}。` : '請留意最新預報。';
}

// `time` is the time the question asked for. A multi-day reply is titled by it: a weekend reply is
// "<city>週末天氣：" and any other is "<city>未來N日預報：".
function formatWeatherReply(weather, timeStr, suggest, time) {
  let reply = '';
  if (suggest) {
    reply += `我先幫你查${weather.city}的天氣；如果之後 API 支援行政區，可以再精準到該區，或者你可以說${suggest}天氣。\n\n`;
  }

  if (weather.isWeek) {
    const title = time === 'weekend'
      ? `${weather.city}週末天氣：`
      : `${weather.city}未來${weather.forecastDays || 7}日預報：`;
    return `${reply}${title}\n${weather.weekSummary}${weather.sourceLabel ? `\n${weather.sourceLabel}` : ''}`;
  }

  reply += `${weather.city}${timeStr}天氣：\n\n`;
  reply += `天氣狀況：${weather.description}\n`;
  reply += `氣溫：${weather.tempMin} ~ ${weather.tempMax}\n`;
  if (weather.forecastPeriod) reply += `預報日期：${weather.forecastPeriod}\n`;

  if (weather.pop) {
    reply += `降雨機率：${weather.pop}\n`;
  }
  if (weather.windDirection) reply += `風向：${weather.windDirection}\n`;
  if (weather.windSpeed) reply += `風速：${weather.windSpeed}\n`;

  reply += `體感提醒：${getAdvice(weather)}`;
  if (weather.sourceLabel) reply += `\n${weather.sourceLabel}`;

  return reply;
}

// What to look up for a question that names no place: the server's default city, read the same
// way the /weather command reads it, or null when the server has none (or only one that cannot
// be told apart, which is no reason to answer for it). A direct message has no server.
function readDefaultLocation(guildId) {
  if (!guildId) return null;
  let defaultCity;
  try {
    defaultCity = getDefaultCity(guildId);
  } catch (error) {
    logger.warn(`weather default city unreadable: ${safeErrorCode(error)}`);
    return null;
  }
  if (!defaultCity) return null;
  const resolved = normalizeWeatherCommandLocation(defaultCity);
  if (resolved.ambiguous || resolved.invalid) return null;
  return resolved.location || null;
}

// Said, with no request to a weather service, to a question about a day the forecast cannot
// answer: a day that is gone, or one beyond the week or so the forecasts cover.
const PAST_TIME_REPLY = '我只能查今天以後的天氣預報，過去的天氣查不到。';
const FAR_TIME_REPLY = '天氣預報大約只涵蓋未來一週，更久以後的天氣目前查不到。';

// The reply to a weather question in chat, or null when the text is not one. `context.guildId`
// is the server it was asked in; it is optional, so a caller that only passes the text still works.
async function getWeatherMentionReply(userText, context = {}) {
  const query = parseWeatherQuery(userText);
  if (!query) {
    return null;
  }

  if (query.unsupportedTime === 'past') return PAST_TIME_REPLY;
  if (query.unsupportedTime === 'far') return FAR_TIME_REPLY;

  if (query.ambiguous) {
    const examples = query.candidates?.slice(0, 4).join('、') || '臺北市大同區、新竹市東區、臺南市東區';
    return `這個地名有點模糊，你可以補上縣市嗎？例如：${examples}`;
  }
  if (query.invalid) {
    return '找不到這個行政區，請輸入完整且正確的縣市與行政區名稱。';
  }

  // apiLocation is what the weather service is asked for: the canonical place, or for a Taiwan
  // place typed in English the name as typed, which the service reads from CWA when it has a key.
  let location = query.apiLocation || query.location;
  // The default city answers a question that names no place. A question that has words this reading
  // could not place ("墾丁天氣") may name one, so it is asked about instead of answered for another city.
  if (!location && !query.hasOtherText) {
    location = readDefaultLocation(context?.guildId);
  }
  if (!location) {
    return '你想查哪裡的天氣呢？例如：臺北市大同區天氣、新北新莊天氣、臺南東區天氣。';
  }

  try {
    const weather = await getWeather(location, query.time);

    const timeLabels = {
      today: '今天',
      tomorrow: '明天',
      day_after_tomorrow: '後天',
      week: '一週',
      weekend: '週末',
    };
    const timeStr = timeLabels[query.time] || '今天';

    return formatWeatherReply(weather, timeStr, query.suggest, query.time);
  } catch (error) {
    if (error instanceof WeatherError && error.code === 'city_not_found') {
      return CITY_NOT_FOUND_MESSAGE;
    }

    logger.warn(`weather mention failed: ${safeErrorCode(error)}`);
    if (error instanceof WeatherError && error.code === 'forecast_unavailable') {
      return FORECAST_UNAVAILABLE_MESSAGE;
    }
    return '天氣資料暫時無法查詢，請稍後再試。';
  }
}

function isWeatherQuery(text) {
  return Boolean(parseWeatherQuery(text));
}

function recordConversationInteraction() {
  return recordPublicInteraction();
}

function createConversationPorts() {
  return Object.freeze({
    weatherPort: Object.freeze({
      getMentionReply: getWeatherMentionReply,
      isQuery: isWeatherQuery,
    }),
    statusPort: Object.freeze({
      recordInteraction: recordConversationInteraction,
    }),
  });
}

module.exports = {
  createConversationPorts,
  getWeatherMentionReply,
  isWeatherQuery,
  recordConversationInteraction,
};
