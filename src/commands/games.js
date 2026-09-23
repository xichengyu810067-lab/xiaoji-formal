const { SlashCommandBuilder } = require('discord.js');
const { createGameSession, DIFFICULTIES, GAME_TYPES } = require('../services/gameService');
const { getEnv } = require('../utils/env');
const { replyEphemeral } = require('../utils/moderation');

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

const gameLabels = { tetris: '俄羅斯方塊', 'number-match': '數字配對', sudoku: '數獨' };
const difficultyLabels = { easy: '簡單', normal: '一般', complex: '複雜', hard: '困難' };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('games')
    .setDescription('開啟小吉的伺服器權威遊戲')
    .setDMPermission(false)
    .addSubcommand((subcommand) => subcommand
      .setName('play')
      .setDescription('建立一次性安全遊戲連結')
      .addStringOption((option) => option.setName('game').setDescription('遊戲').setRequired(true).addChoices(...GAME_TYPES.map((value) => ({ name: gameLabels[value], value }))))
      .addStringOption((option) => option.setName('difficulty').setDescription('難度').setRequired(true).addChoices(...DIFFICULTIES.map((value) => ({ name: difficultyLabels[value], value }))))),

  async execute(interaction) {
    try {
      if (!interaction.guildId || !interaction.channelId) throw new Error('guild only');
      const session = await createGameSession({
        userId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        gameType: interaction.options.getString('game', true),
        difficulty: interaction.options.getString('difficulty', true),
        secret: getEnv('GAME_SESSION_SECRET'),
      });
      const url = buildGameUrl(getEnv('WEBSITE_PUBLIC_URL'), session);
      await replyEphemeral(interaction, `小吉已建立「${gameLabels[session.game]}・${difficultyLabels[session.difficulty]}」的一次性遊戲連結：\n${url}\n連結將在 30 分鐘後失效，且啟動權杖只能使用一次。`);
    } catch (_error) {
      await replyEphemeral(interaction, '小吉目前無法建立遊戲連結，請稍後再試。');
    }
  },
  buildGameUrl,
  parseWebsitePublicUrl,
};
