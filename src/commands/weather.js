const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const { WeatherError, getWeather } = require('../services/weatherService');
const { getGuildConfig } = require('../utils/guildConfig');
const { normalizeWeatherCommandLocation } = require('../utils/weatherNLP');
const logger = require('../utils/logger');

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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('weather')
    .setDescription('查詢天氣')
    .addStringOption((option) =>
      option
        .setName('city')
        .setDescription('城市名稱，例如 Taipei、新竹、信義區')
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
    const defaultCity = interaction.inGuild() ? getGuildConfig(interaction.guildId).weatherDefaultCity : null;
    const city = inputCity || defaultCity;
    const timeType = interaction.options.getString('type') || 'today';

    if (!city) {
      await interaction.reply({
        content: '請輸入城市，例如 `/weather city:Taipei`。若伺服器另有預設城市，請洽管理員確認。',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    try {
      const resolved = normalizeWeatherCommandLocation(city);
      logWeatherDebug(resolved.debug);

      if (resolved.ambiguous) {
        const examples = resolved.candidates?.slice(0, 4).join('、') || '臺北市大同區、新竹市東區、臺南市東區';
        await interaction.editReply(`這個地名有點模糊，你可以補上縣市嗎？例如：${examples}`);
        return;
      }

      const weather = await getWeather(resolved.apiLocation || resolved.location || city, timeType);
      
      let titleSuffix = '';
      if (timeType === 'today') titleSuffix = '今天天氣';
      else if (timeType === 'tomorrow') titleSuffix = '明天天氣';
      else if (timeType === 'week') titleSuffix = '一週天氣';

      const embed = new EmbedBuilder()
        .setColor(0x38bdf8)
        .setTitle(`${weather.city} ${titleSuffix}`)
        .setTimestamp(new Date());

      if (weather.isWeek) {
        embed.setDescription(weather.weekSummary);
      } else {
        embed.setDescription(weather.description);
        embed.addFields(
          { name: '溫度', value: `${weather.tempMin} ~ ${weather.tempMax}`, inline: true },
          { name: '體感', value: weather.feelsLike, inline: true },
          { name: '濕度', value: weather.humidity, inline: true },
          { name: '風速', value: weather.windSpeed, inline: true }
        );
        if (weather.pop) {
          embed.addFields({ name: '降雨機率', value: weather.pop, inline: true });
        }
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      const message = error instanceof WeatherError ? error.message : '查詢天氣失敗，請稍後再試。';
      await interaction.editReply(message);
    }
  },
};
