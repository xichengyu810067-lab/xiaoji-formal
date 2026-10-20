const { SlashCommandBuilder } = require('discord.js');
const {
  MAX_LIST_DAYS,
  addPersonalCalendarEvent,
  deletePersonalEvent,
  formatCalendarEventList,
  listPersonalEvents,
  parseTaipeiCalendarDate,
} = require('../services/calendarService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('calendar')
    .setDescription('管理自己的跨伺服器個人行事曆')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('新增自己的個人行事曆事件')
        .addStringOption((option) =>
          option.setName('title').setDescription('事件標題').setRequired(true).setMaxLength(100)
        )
        .addStringOption((option) =>
          option
            .setName('starts-at')
            .setDescription('台灣時間，例如 2026-05-10 20:00')
            .setRequired(true)
            .setMaxLength(30)
        )
        .addStringOption((option) =>
          option.setName('description').setDescription('事件說明').setMaxLength(1000)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('list')
        .setDescription('跨伺服器列出自己的個人行事曆事件')
        .addIntegerOption((option) =>
          option.setName('days').setDescription('查詢天數，預設 30 天').setMinValue(1).setMaxValue(MAX_LIST_DAYS)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('delete')
        .setDescription('刪除自己的個人行事曆事件')
        .addStringOption((option) =>
          option.setName('id').setDescription('事件 ID，可用 /calendar list 查看').setRequired(true).setMaxLength(80)
        )
    ),

  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.channel?.isTextBased?.()) {
      await interaction.reply({ content: '行事曆只能在伺服器文字頻道內使用。', ephemeral: true });
      return;
    }

    try {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'list') {
        const days = interaction.options.getInteger('days') || 30;
        const events = listPersonalEvents({ userId: interaction.user.id, days });
        await interaction.reply({ content: formatCalendarEventList(events, { days }), ephemeral: true });
        return;
      }

      if (subcommand === 'delete') {
        const event = deletePersonalEvent({
          userId: interaction.user.id,
          eventId: interaction.options.getString('id', true).trim(),
        });
        await interaction.reply({
          content: event ? '已刪除個人行事曆事件。' : '找不到這個個人行事曆事件，或它不是你建立的。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'add') {
        const startsAt = parseTaipeiCalendarDate(interaction.options.getString('starts-at', true));
        if (!startsAt) {
          await interaction.reply({ content: '請輸入台灣時間，格式為 YYYY-MM-DD HH:mm。', ephemeral: true });
          return;
        }
        const result = addPersonalCalendarEvent({
          interactionId: interaction.id,
          userId: interaction.user.id,
          sourceGuildId: interaction.guildId,
          title: interaction.options.getString('title', true),
          description: interaction.options.getString('description') || '',
          startsAt: startsAt.getTime(),
          createdAt: interaction.createdTimestamp,
        });
        if (result.tooFarAhead) {
          await interaction.reply({
            content: '事件時間最多只能設在現在起 ' + result.maxDays + ' 天內，請輸入較近的日期。',
            ephemeral: true,
          });
          return;
        }
        if (result.limitReached) {
          await interaction.reply({
            content: '你的個人行事曆已經有 ' + result.limit + ' 筆尚未結束的事件，' +
              '請先用 /calendar delete 刪除不需要的事件，再新增。',
            ephemeral: true,
          });
          return;
        }
        if (result.deleted) {
          await interaction.reply({
            content: '這個行事曆新增請求先前已刪除，不會重新建立。',
            ephemeral: true,
          });
          return;
        }
        const event = result.event;
        await interaction.reply({
          content: '已新增個人行事曆事件：' + event.id + ' - <t:' +
            Math.floor(event.startsAt / 1000) + ':F> - ' + event.title,
          ephemeral: true,
        });
      }
    } catch (error) {
      const response = {
        content: '行事曆資料目前無法安全讀寫，請聯絡管理員檢查資料檔與初始化狀態。',
        ephemeral: true,
      };
      if (interaction.replied || interaction.deferred) await interaction.followUp(response);
      else await interaction.reply(response);
    }
  },
};
