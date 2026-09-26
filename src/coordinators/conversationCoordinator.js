const { WeatherError, getWeather } = require('../services/weatherService');
const { parseWeatherQuery } = require('../utils/weatherNLP');
const { recordPublicInteraction } = require('../services/publicStatusService');
const logger = require('../utils/logger');

function getAdvice(weather) {
  const advice = [];

  if (weather.tempMaxRaw >= 30) {
    advice.push('天氣炎熱，請注意防曬並多補充水分');
  } else if (weather.tempMinRaw <= 15) {
    advice.push('天氣偏冷，出門請記得穿暖一點');
  } else {
    advice.push('氣溫舒適，出門保持一般準備就可以');
  }

  if (weather.popRaw > 0.4) {
    advice.push('降雨機率偏高，建議帶傘');
  } else if (weather.popRaw > 0.1) {
    advice.push('有一點降雨機率，可以視情況帶傘');
  }

  return `${advice.join('，')}。`;
}

function formatWeatherReply(weather, timeStr, suggest) {
  let reply = '';
  if (suggest) {
    reply += `我先幫你查${weather.city}的天氣；如果之後 API 支援行政區，可以再精準到該區，或者你可以說${suggest}天氣。\n\n`;
  }

  if (weather.isWeek) {
    return `${weather.city}未來一週天氣：\n${weather.weekSummary}`;
  }

  reply += `${weather.city}${timeStr}天氣：\n\n`;
  reply += `天氣狀況：${weather.description}\n`;
  reply += `氣溫：${weather.tempMin} ~ ${weather.tempMax}\n`;

  if (weather.pop) {
    reply += `降雨機率：${weather.pop}\n`;
  }

  reply += `體感提醒：${getAdvice(weather)}`;

  return reply;
}

function logWeatherDebug(debug) {
  logger.info(
    [
      `[weather:${debug.source}] raw="${debug.raw}"`,
      `cleaned="${debug.cleaned}"`,
      `normalized="${debug.normalized}"`,
      `intent=${debug.isWeatherIntent}`,
      `city="${debug.city || ''}"`,
      `district="${debug.district || ''}"`,
      `final="${debug.finalLocation || ''}"`,
      `api="${debug.apiLocation || ''}"`,
    ].join(' ')
  );
}

async function getWeatherMentionReply(userText) {
  const query = parseWeatherQuery(userText);
  if (!query) {
    return null;
  }

  logWeatherDebug(query.debug);

  if (query.ambiguous) {
    const examples = query.candidates?.slice(0, 4).join('、') || '臺北市大同區、新竹市東區、臺南市東區';
    return `這個地名有點模糊，你可以補上縣市嗎？例如：${examples}`;
  }

  if (!query.location) {
    return '你想查哪裡的天氣呢？例如：臺北市大同區天氣、新北新莊天氣、臺南東區天氣。';
  }

  try {
    const weather = await getWeather(query.apiLocation || query.location, query.time);

    const timeLabels = {
      today: '今天',
      tomorrow: '明天',
      day_after_tomorrow: '後天',
      week: '一週',
      weekend: '週末',
    };
    const timeStr = timeLabels[query.time] || '今天';

    return formatWeatherReply(weather, timeStr, query.suggest);
  } catch (error) {
    if (error instanceof WeatherError && error.code === 'missing_api_key') {
      return '小吉有查詢天氣功能，但目前還沒設定 `OPENWEATHER_API_KEY`。請在 `.env` 補上後重新啟動小吉。';
    }

    if (error instanceof WeatherError && error.code === 'unauthorized') {
      return '小吉有查詢天氣功能，但 OpenWeather API key 目前無效或尚未啟用。請確認 `.env` 的 `OPENWEATHER_API_KEY` 是正確 key，儲存後重新啟動小吉。';
    }

    if (error instanceof WeatherError && error.code === 'city_not_found') {
      return '我找不到這個地名的天氣資料。請試著補上縣市與行政區，例如：臺北市大同區天氣。';
    }

    logger.warn(`weather mention failed: ${error?.message || error}`);
    return '我剛剛有抓到地點，但天氣資料查詢失敗。可能是 API 暫時沒有回應，請稍後再試。';
  }
}

function isWeatherQuery(text) {
  return Boolean(parseWeatherQuery(text));
}

function recordConversationInteraction() {
  return recordPublicInteraction();
}

module.exports = { getWeatherMentionReply, isWeatherQuery, recordConversationInteraction };
