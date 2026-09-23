const { SlashCommandBuilder } = require('discord.js');
const { createPoll } = require('../services/pollService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('建立按鈕投票')
    .addStringOption((option) =>
      option.setName('question').setDescription('投票問題').setRequired(true).setMaxLength(200)
    )
    .addStringOption((option) =>
      option.setName('option1').setDescription('選項 1').setRequired(true).setMaxLength(100)
    )
    .addStringOption((option) =>
      option.setName('option2').setDescription('選項 2').setRequired(true).setMaxLength(100)
    )
    .addStringOption((option) => option.setName('option3').setDescription('選項 3').setMaxLength(100))
    .addStringOption((option) => option.setName('option4').setDescription('選項 4').setMaxLength(100))
    .addStringOption((option) => option.setName('option5').setDescription('選項 5').setMaxLength(100))
    .addIntegerOption((option) =>
      option
        .setName('duration-minutes')
        .setDescription('投票時間，預設 10 分鐘')
        .setMinValue(1)
        .setMaxValue(1440)
    ),

  async execute(interaction) {
    const options = [1, 2, 3, 4, 5]
      .map((index) => interaction.options.getString(`option${index}`))
      .filter(Boolean);

    await createPoll(interaction, {
      question: interaction.options.getString('question', true),
      options,
      durationMinutes: interaction.options.getInteger('duration-minutes') || 10,
    });
  },
};
