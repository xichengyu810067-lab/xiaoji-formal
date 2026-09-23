const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roll')
    .setDescription('擲骰子')
    .addIntegerOption((option) =>
      option
        .setName('sides')
        .setDescription('骰子的面數')
        .setMinValue(2)
        .setMaxValue(1000)
    )
    .addIntegerOption((option) =>
      option
        .setName('count')
        .setDescription('骰子顆數')
        .setMinValue(1)
        .setMaxValue(20)
    ),

  async execute(interaction) {
    const sides = interaction.options.getInteger('sides') ?? 6;
    const count = interaction.options.getInteger('count') ?? 1;
    const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
    const total = rolls.reduce((sum, value) => sum + value, 0);

    await interaction.reply(`擲出 ${count}d${sides}：${rolls.join(', ')}，總和 ${total}`);
  },
};
