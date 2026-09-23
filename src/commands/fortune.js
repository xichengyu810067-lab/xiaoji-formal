const { SlashCommandBuilder } = require('discord.js');

const fortunes = [
  '大吉：今天適合把最重要的事先完成。',
  '中吉：保持節奏，事情會比想像中順。',
  '小吉：先處理小問題，後面會輕鬆很多。',
  '末吉：慢一點沒關係，先確認方向。',
  '吉：有人會因為你的細心少踩一個坑。',
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('fortune')
    .setDescription('抽一則小吉籤'),

  async execute(interaction) {
    const index = Math.floor(Math.random() * fortunes.length);
    await interaction.reply(fortunes[index]);
  },
};
