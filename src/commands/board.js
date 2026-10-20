const { ChannelType, SlashCommandBuilder } = require('discord.js');
const { BOARD_GAME_CHOICES, getGame } = require('../../website/gameCatalog');
const { getBoardRuntime } = require('../systems/games/board/core/boardRuntimeRegistry');
const { MAX_CASINO_AMOUNT } = require('../services/casinoService');
const { MAX_CHIP_AMOUNT } = require('../services/chipService');
const { endOwnSoloGame, showUnifiedGameStatus, startUnifiedGame } = require('../coordinators/gameLaunchCoordinator');
const { replyEphemeral } = require('../utils/moderation');

const DIFFICULTY_CHOICES = [
  { name: '簡單', value: 'easy' },
  { name: '一般', value: 'normal' },
  { name: '複雜', value: 'complex' },
  { name: '困難', value: 'hard' },
];

const CHOICE_OPTIONS = Object.freeze({
  'casino-dice': [
    { name: '大（8–12）', value: 'big' },
    { name: '小（2–6）', value: 'small' },
    { name: '指定 7 點', value: 'seven' },
  ],
  'casino-roulette': [
    { name: '紅色', value: 'red' }, { name: '黑色', value: 'black' },
    { name: '單數', value: 'odd' }, { name: '雙數', value: 'even' },
    { name: '零', value: 'zero' },
  ],
  'casino-baccarat': [
    { name: '閒家', value: 'player' }, { name: '莊家', value: 'banker' }, { name: '和局', value: 'tie' },
  ],
});

const data = new SlashCommandBuilder()
  .setName('board')
  .setDescription('小吉的統一遊戲入口')
  .setDMPermission(false)
  .addSubcommand((subcommand) => subcommand
    .setName('start')
    .setDescription('選擇並開始遊戲')
    .addStringOption((option) => option
      .setName('game')
      .setDescription('選擇遊戲')
      .setRequired(true)
      .addChoices(...BOARD_GAME_CHOICES))
    .addStringOption((option) => option
      .setName('difficulty')
      .setDescription('個人遊戲難度')
      .addChoices(...DIFFICULTY_CHOICES))
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('接龍遊戲頻道；未填時使用目前頻道')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addStringOption((option) => option.setName('seed').setDescription('文字接龍起始字').setMaxLength(6))
    .addIntegerOption((option) => option
      .setName('target').setDescription('數字接龍目標數字').setMinValue(1).setMaxValue(Number.MAX_SAFE_INTEGER))
    .addIntegerOption((option) => option
      .setName('amount').setDescription('賭場下注籌碼').setMinValue(1).setMaxValue(MAX_CASINO_AMOUNT))
    .addStringOption((option) => option
      .setName('choice').setDescription('骰子、輪盤或百家樂選項').setAutocomplete(true))
    .addStringOption((option) => option
      .setName('weapon-item-id').setDescription('決鬥塔台武器商品 ID').setMinLength(38).setMaxLength(38))
    .addIntegerOption((option) => option
      .setName('wager').setDescription('決鬥塔台下注籌碼').setMinValue(1).setMaxValue(MAX_CHIP_AMOUNT)))
  .addSubcommand((subcommand) => subcommand.setName('join').setDescription('加入目前頻道的公開等候室'))
  .addSubcommand((subcommand) => subcommand.setName('leave').setDescription('離開等候室；對局中使用時視為認輸'))
  .addSubcommand((subcommand) => subcommand
    .setName('status')
    .setDescription('查看遊戲目錄、現存遊戲或重新整理指定遊戲')
    .addStringOption((option) => option.setName('game').setDescription('只查看指定遊戲').addChoices(...BOARD_GAME_CHOICES)))
  .addSubcommand((subcommand) => subcommand.setName('stop').setDescription('房主取消等候室或結束海龜湯；也可結束你自己的個人遊戲'));

module.exports = {
  data,

  async autocomplete(interaction) {
    const game = getGame(interaction.options.getString('game'));
    const choices = CHOICE_OPTIONS[game?.key] || [];
    const query = String(interaction.options.getFocused() || '').toLowerCase();
    await interaction.respond(choices.filter(({ name, value }) =>
      name.toLowerCase().includes(query) || value.includes(query)).slice(0, 25));
  },

  async execute(interaction) {
    const action = interaction.options.getSubcommand();
    if (action === 'start') return startUnifiedGame(interaction);
    if (action === 'status') return showUnifiedGameStatus(interaction);
    if (action === 'stop') {
      // Ends the caller's own personal game in this channel; null means the board's own stop is to answer.
      const ended = await endOwnSoloGame(interaction);
      if (ended) return ended;
    }
    try {
      return await getBoardRuntime().executeCommand(interaction);
    } catch (error) {
      if (error?.code !== 'RUNTIME_NOT_CONFIGURED') throw error;
      await replyEphemeral(interaction, '小吉桌遊目前尚未完成啟動，請稍後再試。');
      return { ok: false, code: error.code };
    }
  },
};
