const { SlashCommandBuilder } = require('discord.js');
const {
  MAX_LODGING_NIGHTS,
  RoomTypes,
  bookLodging,
  getCasinoLobby,
  listLodging,
} = require('../services/casinoFacilityService');
const { formatChips, replyCoinError } = require('../utils/coinPresentation');

const roomChoices = Object.values(RoomTypes).map((room) => ({
  name: `${room.name}｜每晚 ${room.nightlyRate.toLocaleString('zh-TW')} 籌碼`,
  value: room.type,
}));

function formatAutoTopUp(result) {
  return result.autoTopUpAmount > 0 ? `籌碼不足，已自動用吉幣兌換 ${formatChips(result.autoTopUpAmount)}。` : null;
}

function formatTimestamp(isoString, mode = 'F') {
  const timestamp = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${timestamp}:${mode}>`;
}

function formatStayLine(booking) {
  return [
    `#${booking.id}`,
    booking.roomName,
    `${booking.nights} 晚`,
    formatChips(booking.chipAmount),
    `${formatTimestamp(booking.checkInAt, 'd')} -> ${formatTimestamp(booking.checkOutAt, 'd')}`,
  ].join('｜');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('casino-lobby')
    .setDescription('查看小吉賭場大廳、下注區與住宿')
    .addSubcommand((subcommand) => subcommand.setName('guide').setDescription('查看賭場各區導覽'))
    .addSubcommand((subcommand) => subcommand.setName('betting-area').setDescription('查看下注區可用遊戲'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('stay')
        .setDescription('使用籌碼登記賭場住宿')
        .addStringOption((option) =>
          option.setName('room').setDescription('房型').setRequired(true).addChoices(...roomChoices)
        )
        .addIntegerOption((option) =>
          option.setName('nights').setDescription('住宿天數').setRequired(true).setMinValue(1).setMaxValue(MAX_LODGING_NIGHTS)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('stays')
        .setDescription('查看自己的住宿紀錄')
        .addIntegerOption((option) => option.setName('limit').setDescription('顯示筆數').setMinValue(1).setMaxValue(25))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '賭場大廳只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'guide') {
        const lobby = await getCasinoLobby();
        const lines = lobby.areas.map((area) => `**${area.name}**｜\`${area.command}\`\n${area.description}`);
        await interaction.reply({
          content: ['**小吉賭場大廳導覽**', ...lines].join('\n\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'betting-area') {
        await interaction.reply({
          content: [
            '**小吉賭場｜下注區**',
            '`/casino dice`：骰子',
            '`/casino slots`：角子機',
            '`/casino blackjack`：21 點',
            '`/casino roulette`：輪盤',
            '`/casino baccarat`：百家樂',
            '`/casino poker`：五張牌撲克牌',
            '',
            '下注區一律優先使用籌碼；籌碼不足時，小吉會自動用吉幣補足下注所需籌碼。',
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'stay') {
        const result = await bookLodging(interaction.guildId, interaction.user.id, {
          roomType: interaction.options.getString('room', true),
          nights: interaction.options.getInteger('nights', true),
        });
        await interaction.reply({
          content: [
            '**小吉賭場｜住宿登記完成**',
            `房型：${result.booking.roomName}`,
            `天數：${result.booking.nights} 晚`,
            `支付：${formatChips(result.booking.chipAmount)}`,
            `入住：${formatTimestamp(result.booking.checkInAt)}`,
            `退房：${formatTimestamp(result.booking.checkOutAt)}`,
            `籌碼餘額：${formatChips(result.balanceAfter)}`,
            formatAutoTopUp(result),
          ]
            .filter(Boolean)
            .join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'stays') {
        const rows = await listLodging(interaction.guildId, interaction.user.id, {
          limit: interaction.options.getInteger('limit') || 10,
        });
        await interaction.reply({
          content: rows.length ? ['**小吉賭場｜住宿紀錄**', ...rows.map(formatStayLine)].join('\n') : '目前沒有住宿紀錄。',
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error, '小吉賭場大廳剛剛執行失敗了，請稍後再試。');
    }
  },
};
