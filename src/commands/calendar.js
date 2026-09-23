const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  createCalendarEvent,
  deleteCalendarEvent,
  formatCalendarEventList,
  listUpcomingEvents,
  parseCalendarDate,
  saveCalendarEvent,
} = require('../services/calendarService');
const { ensureModerationAccess } = require('../utils/moderation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('calendar')
    .setDescription('管理伺服器行事曆')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('新增行事曆事件')
        .addStringOption((option) =>
          option.setName('title').setDescription('事件標題').setRequired(true).setMaxLength(100)
        )
        .addStringOption((option) =>
          option
            .setName('starts-at')
            .setDescription('開始時間，例如 2026-05-10 20:00')
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
        .setDescription('列出 upcoming 行事曆事件')
        .addIntegerOption((option) =>
          option.setName('days').setDescription('查詢天數，預設 30 天').setMinValue(1).setMaxValue(365)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('delete')
        .setDescription('刪除行事曆事件')
        .addStringOption((option) =>
          option.setName('id').setDescription('事件 ID，可用 /calendar list 查看').setRequired(true).setMaxLength(80)
        )
    ),

  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.channel?.isTextBased?.()) {
      await interaction.reply({ content: '行事曆只能在伺服器文字頻道內使用。', ephemeral: true });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'list') {
      const events = listUpcomingEvents({
        guildId: interaction.guildId,
        days: interaction.options.getInteger('days') || 30,
      });
      await interaction.reply({ content: formatCalendarEventList(events), ephemeral: true });
      return;
    }

    const access = await ensureModerationAccess(interaction, {
      userPermission: PermissionFlagsBits.ManageGuild,
      userPermissionName: 'Manage Server',
    });

    if (!access.ok) {
      return;
    }

    if (subcommand === 'delete') {
      const event = deleteCalendarEvent({
        guildId: interaction.guildId,
        eventId: interaction.options.getString('id', true).trim(),
      });

      await interaction.reply({
        content: event ? `已刪除行事曆事件：${event.title}` : '找不到這個行事曆事件。',
        ephemeral: true,
      });
      return;
    }

    const startsAt = parseCalendarDate(interaction.options.getString('starts-at', true));

    if (!startsAt) {
      await interaction.reply({
        content: '時間格式請使用 `YYYY-MM-DD HH:mm`，例如 `2026-05-10 20:00`。',
        ephemeral: true,
      });
      return;
    }

    const event = createCalendarEvent({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      createdBy: interaction.user.id,
      title: interaction.options.getString('title', true),
      description: interaction.options.getString('description') || '',
      startsAt: startsAt.getTime(),
    });

    saveCalendarEvent(event);

    await interaction.reply({
      content: `已新增行事曆事件：\`${event.id}\` - <t:${Math.floor(event.startsAt / 1000)}:F> - ${event.title}`,
      ephemeral: true,
    });
  },
};
