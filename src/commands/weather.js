const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const {
  WeatherError,
  getDefaultCity,
  getWeather,
  safeErrorCode,
  CITY_NOT_FOUND_MESSAGE,
} = require('../services/weatherService');
const { normalizeWeatherCommandLocation } = require('../utils/weatherNLP');
const { sanitizeUserFacingOutput } = require('../systems/conversation/userFacingOutputPolicy');
const logger = require('../utils/logger');

const NO_MENTIONS = Object.freeze({ parse: [], users: [], roles: [], repliedUser: false });

// Every /weather reply disables mention parsing, including error text that
// echoes the city the user typed (for example "找不到城市：@everyone").
const plainReply = (content) => ({ content, allowedMentions: NO_MENTIONS });

module.exports = {
  data: new SlashCommandBuilder()
    .setName('weather')
    .setDescription('查詢天氣')
    .addStringOption((option) =>
      option
        .setName('city')
        .setDescription('城市名稱，例如 Taipei、臺北市信義區、新北市新莊區、Tokyo')
        .setMaxLength(100)
    )
    .addStringOption((option) =>
      option
        .setName('type')
        .setDescription('查詢時間類型 (今天、明天、一週)')
        .addChoices(
          { name: '今天', value: 'today' },
          { name: '明天', value: 'tomorrow' },
          { name: '一週', value: 'week' }
        )
    ),

  async execute(interaction) {
    const inputCity = interaction.options.getString('city');
    const defaultCity = interaction.inGuild() ? getDefaultCity(interaction.guildId) : null;
    const city = inputCity || defaultCity;
    const timeType = interaction.options.getString('type') || 'today';

    if (!city) {
      await interaction.reply({
        content: '請輸入城市，例如 `/weather city:Taipei`。若伺服器另有預設城市，請洽管理員確認。',
        ephemeral: true,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    await interaction.deferReply();
    const outputContext = {
      actorId: interaction.user?.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    };
    // The weather text comes from a third-party service, not from the AI: a link in it is cleaned and logged as
    // before, but is no attack to tell the Owner of (no security alert).
    const safe = (value) => sanitizeUserFacingOutput(value, { context: outputContext, securityAlert: false });
    // An error reply can echo what the user typed ("找不到城市：<輸入>"), so its links
    // and mentions are rewritten too. Nothing is emitted: a user typing a link is
    // not a safety event for the owner.
    const safeQuietly = (value) => sanitizeUserFacingOutput(value, { context: outputContext, emit: () => {} });

    try {
      const resolved = normalizeWeatherCommandLocation(city);

      if (resolved.ambiguous) {
        const examples = resolved.candidates?.slice(0, 4).join('、') || '臺北市大同區、新竹市東區、臺南市東區';
        await interaction.editReply(plainReply(`這個地名有點模糊，你可以補上縣市嗎？例如：${examples}`));
        return;
      }
      if (resolved.invalid) {
        await interaction.editReply(plainReply('找不到這個行政區，請輸入完整且正確的縣市與行政區名稱。'));
        return;
      }

      const weather = await getWeather(resolved.location || city, timeType);
      
      let titleSuffix = '';
      if (timeType === 'today') titleSuffix = weather.source === 'cwa' ? '今日預報' : '今天天氣';
      else if (timeType === 'tomorrow') titleSuffix = '明日預報';
      else if (timeType === 'week') titleSuffix = `${weather.forecastDays || 7}日預報`;

      const embed = new EmbedBuilder()
        .setColor(0x38bdf8)
        .setTitle(safe(`${weather.city} ${titleSuffix}`))
        .setTimestamp(new Date());

      if (weather.isWeek) {
        embed.setDescription(safe(weather.weekSummary));
      } else {
        embed.setDescription(safe(weather.description));
        embed.addFields(
          { name: '溫度', value: safe(`${weather.tempMin} ~ ${weather.tempMax}`), inline: true },
          { name: '體感', value: safe(weather.feelsLike), inline: true },
          { name: '濕度', value: safe(weather.humidity), inline: true },
          { name: '風速', value: safe(weather.windSpeed), inline: true }
        );
        if (weather.windDirection) {
          embed.addFields({ name: '風向', value: safe(weather.windDirection), inline: true });
        }
        if (weather.pop) {
          embed.addFields({ name: '降雨機率', value: safe(weather.pop), inline: true });
        }
      }
      if (weather.forecastPeriod) embed.addFields({ name: '預報日期', value: safe(weather.forecastPeriod) });
      if (weather.sourceLabel) embed.setFooter({ text: safe(weather.sourceLabel) });

      await interaction.editReply({ embeds: [embed], allowedMentions: NO_MENTIONS });
    } catch (error) {
      // A mistyped city is the user's mistake, not a failure, so it is not logged
      // (the AI path skips it too). Every other error code is logged.
      if (!(error instanceof WeatherError && error.code === 'city_not_found')) {
        logger.warn(`weather command failed: ${safeErrorCode(error)}`);
      }
      // Never echo user input in error replies. city_not_found uses a fixed message.
      let message;
      if (error instanceof WeatherError && error.code === 'city_not_found') {
        message = CITY_NOT_FOUND_MESSAGE;
      } else if (error instanceof WeatherError) {
        message = error.message;
      } else {
        message = '查詢天氣失敗，請稍後再試。';
      }
      await interaction.editReply(plainReply(safeQuietly(message)));
    }
  },
};
