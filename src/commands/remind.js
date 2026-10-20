const { SlashCommandBuilder } = require('discord.js');
const {
  addReminder,
  createReminder,
  deleteUserReminder,
  listUserReminders,
  parseReminderDuration,
} = require('../services/reminderService');
const { clipText, fitListText, omittedLine } = require('../utils/replyLengthGuard');

const MAX_LISTED_REMINDERS = 10;

// At most ten reminders, one line each. A reminder can be a thousand characters long, so when the lines do not fit
// one message the texts are shortened, and reminders that still do not fit are left out with a line that says how
// many (the reminders past the tenth count too).
function formatReminderList(reminders) {
  if (reminders.length === 0) {
    return '目前沒有尚未完成的提醒。';
  }

  return fitListText({
    items: reminders.slice(0, MAX_LISTED_REMINDERS),
    totalCount: reminders.length,
    render: (reminder, { textLimit }) => {
      const status = reminder.status === 'failed'
        ? ' [失敗：' + clipText(reminder.failureReason || '請人工核對', textLimit) + ']'
        : reminder.status === 'sending' ? ' [投遞確認中]' : '';
      return '`' + reminder.id + '` - <t:' + Math.floor(reminder.remindAt / 1000) + ':R> - ' +
        clipText(reminder.message, textLimit) + status;
    },
    note: (count) => omittedLine(count, { unit: '則提醒', hint: '前面的提醒送出或刪除後才會顯示' }),
  });
}

// What the subcommand answers, as a reply. It reads and writes the reminder data, and so is the only part whose
// failure means the data cannot be used.
function answerFor(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'list') {
    const reminders = listUserReminders({
      userId: interaction.user.id,
    });
    return { content: formatReminderList(reminders), ephemeral: true };
  }

  if (subcommand === 'delete') {
    const reminderId = interaction.options.getString('id', true).trim();
    const removed = deleteUserReminder({
      userId: interaction.user.id,
      reminderId,
    });

    return {
      content: removed ? `已刪除提醒：${removed.message}` : '找不到這個提醒，或它不是你建立的提醒。',
      ephemeral: true,
    };
  }

  const duration = parseReminderDuration(interaction.options.getString('time', true));

  if (!duration) {
    return {
      content: '時間格式請使用 10m、1h、1d 這類格式，最長 30 天。',
      ephemeral: true,
    };
  }

  const reminder = createReminder({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    message: interaction.options.getString('message', true),
    durationMs: duration.ms,
  });

  addReminder(interaction.client, reminder);

  return {
    content: `提醒已設定：\`${reminder.id}\`，<t:${Math.floor(reminder.remindAt / 1000)}:R> 我會在這個頻道提醒你。`,
    ephemeral: true,
  };
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

    let response;
    try {
      response = answerFor(interaction);
    } catch (error) {
      // Only the reminder data (read, check, write) can fail here. The reply below is outside this block, so a
      // message Discord refuses or an interaction that has gone is never reported as unreadable reminder data.
      response = {
        content: error?.code === 'REMINDER_ACTIVE_LIMIT'
          ? '你目前已有 20 則進行中的提醒；請先完成或刪除一則後再新增。'
          : '提醒資料目前無法安全讀寫，請聯絡管理員檢查資料檔與初始化狀態。',
        ephemeral: true,
      };
    }

    if (interaction.replied || interaction.deferred) await interaction.followUp(response);
    else await interaction.reply(response);
  },
};

module.exports.formatReminderList = formatReminderList;
