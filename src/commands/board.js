const { SlashCommandBuilder } = require('discord.js');
const { GAME_CHOICES } = require('../games/discord/boardControls');
const { getBoardRuntime } = require('../games/boardRuntimeRegistry');
const { replyEphemeral } = require('../utils/moderation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('board')
    .setDescription('在目前頻道遊玩小吉桌遊')
    .setDMPermission(false)
    .addSubcommand((subcommand) => subcommand
      .setName('start')
      .setDescription('建立公開等候室，由房主按按鈕開始')
      .addStringOption((option) => option
        .setName('game')
        .setDescription('選擇遊戲')
        .setRequired(true)
        .addChoices(...GAME_CHOICES)))
    .addSubcommand((subcommand) => subcommand.setName('join').setDescription('加入目前頻道的等候室'))
    .addSubcommand((subcommand) => subcommand.setName('leave').setDescription('離開等候室；對局中使用時視為認輸'))
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('查看並重新整理目前棋局'))
    .addSubcommand((subcommand) => subcommand.setName('stop').setDescription('由房主取消等候室或結束海龜湯')),

  async execute(interaction) {
    try {
      return await getBoardRuntime().executeCommand(interaction);
    } catch (error) {
      if (error?.code !== 'RUNTIME_NOT_CONFIGURED') throw error;
      await replyEphemeral(interaction, '小吉桌遊目前尚未完成啟動，請稍後再試。');
      return { ok: false, code: error.code };
    }
  },
};
