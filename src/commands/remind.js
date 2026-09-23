const { SlashCommandBuilder } = require('discord.js');
const {
  addReminder,
  createReminder,
  deleteUserReminder,
  listUserReminders,
  parseReminderDuration,
} = require('../services/reminderService');

function formatReminderList(reminders) {
  if (reminders.length === 0) {
    return '目前沒有尚未完成的提醒。';
  }

  return reminders
    .slice(0, 10)
    .map((reminder) => `\`${reminder.id}\` - <t:${Math.floor(reminder.remindAt / 1000)}:R> - ${reminder.message}`)
    .join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('管理提醒')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('新增提醒')
        .addStringOption((option) =>
          option
            .setName('time')
            .setDescription('相對時間，例如 10m、1h、1d')
            .setRequired(true)
            .setMaxLength(12)
        )
        .addStringOption((option) =>
          option
            .setName('message')
            .setDescription('提醒內容')
            .setRequired(true)
            .setMaxLength(1000)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('list').setDescription('列出我的提醒'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('delete')
        .setDescription('刪除我的提醒')
        .addStringOption((option) =>
          option.setName('id').setDescription('提醒 ID，可用 /remind list 查看').setRequired(true).setMaxLength(80)
        )
    ),

  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.channel?.isTextBased?.()) {
      await interaction.reply({ content: '提醒只能在伺服器文字頻道內使用。', ephemeral: true });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'list') {
      const reminders = listUserReminders({
        guildId: interaction.guildId,
        userId: interaction.user.id,
      });
      await interaction.reply({ content: formatReminderList(reminders), ephemeral: true });
      return;
    }

    if (subcommand === 'delete') {
      const reminderId = interaction.options.getString('id', true).trim();
      const removed = deleteUserReminder({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        reminderId,
      });

      await interaction.reply({
        content: removed ? `已刪除提醒：${removed.message}` : '找不到這個提醒，或它不是你建立的提醒。',
        ephemeral: true,
      });
      return;
    }

    const duration = parseReminderDuration(interaction.options.getString('time', true));

    if (!duration) {
      await interaction.reply({
        content: '時間格式請使用 10m、1h、1d 這類格式，最長 30 天。',
        ephemeral: true,
      });
      return;
    }

    const reminder = createReminder({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      message: interaction.options.getString('message', true),
      durationMs: duration.ms,
    });

    addReminder(interaction.client, reminder);

    await interaction.reply({
      content: `提醒已設定：\`${reminder.id}\`，<t:${Math.floor(reminder.remindAt / 1000)}:R> 我會在這個頻道提醒你。`,
      ephemeral: true,
    });
  },
};

module.exports.formatReminderList = formatReminderList;
