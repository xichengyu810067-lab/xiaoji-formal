const { WeatherError, getWeather } = require('../services/weatherService');
const { parseWeatherQuery } = require('../utils/weatherNLP');
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

function formatWeatherReply(weather, timeStr, suggest) {
  let reply = '';
  if (suggest) {
    reply += `我先幫你查${weather.city}的天氣；如果之後 API 支援行政區，可以再精準到該區，或者你可以說${suggest}天氣。\n\n`;
  }

  if (weather.isWeek) {
    return `${weather.city}未來${weather.forecastDays || 7}日預報：\n${weather.weekSummary}${weather.sourceLabel ? `\n${weather.sourceLabel}` : ''}`;
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

async function getWeatherMentionReply(userText) {
  const query = parseWeatherQuery(userText);
  if (!query) {
    return null;
  }

  if (query.ambiguous) {
    const examples = query.candidates?.slice(0, 4).join('、') || '臺北市大同區、新竹市東區、臺南市東區';
    return `這個地名有點模糊，你可以補上縣市嗎？例如：${examples}`;
  }
  if (query.invalid) {
    return '找不到這個行政區，請輸入完整且正確的縣市與行政區名稱。';
  }

  if (!query.location) {
    return '你想查哪裡的天氣呢？例如：臺北市大同區天氣、新北新莊天氣、臺南東區天氣。';
  }

  try {
    const weather = await getWeather(query.location, query.time);

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
    if (error instanceof WeatherError && error.code === 'city_not_found') {
      return '我找不到這個地名的天氣資料。請試著補上縣市與行政區，例如：臺北市大同區天氣。';
    }

    logger.warn(`weather mention failed: ${error?.code || 'unknown'}`);
    return '天氣資料暫時無法查詢，請稍後再試。';
  }
}

function isWeatherQuery(text) {
  return Boolean(parseWeatherQuery(text));
}

function recordConversationInteraction() {
  return recordPublicInteraction();
}

module.exports = { getWeatherMentionReply, isWeatherQuery, recordConversationInteraction };
