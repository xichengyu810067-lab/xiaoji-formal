const { SlashCommandBuilder } = require('discord.js');
const { DIFFICULTIES, GAME_TYPES } = require('../services/gameRewardPolicy');
const { getSoloRuntime } = require('../systems/games/soloRuntimeRegistry');
const { replyEphemeral } = require('../utils/moderation');

const gameLabels = { tetris: '俄羅斯方塊', 'number-match': '數字配對', sudoku: '數獨' };
const difficultyLabels = { easy: '簡單', normal: '一般', complex: '複雜', hard: '困難' };

// Historical helpers remain available to inspect legacy sessions during the drain.
function parseWebsitePublicUrl(value) {
  const url = new URL(String(value || ''));
  const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.search || url.hash) {
    throw new Error('WEBSITE_PUBLIC_URL must be HTTPS or loopback HTTP.');
  }
  return url;
}

function buildGameUrl(baseUrl, session) {
  const url = new URL(`games/${session.game}`, parseWebsitePublicUrl(baseUrl).toString().replace(/\/?$/, '/'));
  url.searchParams.set('difficulty', session.difficulty);
  url.hash = `token=${encodeURIComponent(session.launchToken)}`;
  return url.toString();
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('games')
    .setDescription('遊玩小吉的 Discord 遊戲')
    .setDMPermission(false)
    .addSubcommand((subcommand) => subcommand.setName('menu').setDescription('查看所有遊戲'))
    .addSubcommand((subcommand) => subcommand.setName('resume').setDescription('重新顯示目前頻道的個人遊戲'))
    .addSubcommand((subcommand) => subcommand
      .setName('play')
      .setDescription('在 Discord 開始個人遊戲')
      .addStringOption((option) => option.setName('game').setDescription('遊戲').setRequired(true)
        .addChoices(...GAME_TYPES.map((value) => ({ name: gameLabels[value], value }))))
      .addStringOption((option) => option.setName('difficulty').setDescription('難度').setRequired(true)
        .addChoices(...DIFFICULTIES.map((value) => ({ name: difficultyLabels[value], value }))))),

  async execute(interaction) {
    try {
      return await getSoloRuntime().executeCommand(interaction);
    } catch (error) {
      if (error?.code !== 'RUNTIME_NOT_CONFIGURED') throw error;
      await replyEphemeral(interaction, '小吉遊戲目前尚未完成啟動，請稍後再試。');
      return { ok: false, code: error.code };
    }
  },
  buildGameUrl,
  parseWebsitePublicUrl,
};
