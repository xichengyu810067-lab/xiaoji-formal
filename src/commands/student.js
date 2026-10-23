const { SlashCommandBuilder } = require('discord.js');
const { executeStudentCommand } = require('../systems/conversation/student');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('student')
    .setDescription('小吉化身好奇寶寶向你提問')
    .setDMPermission(false)
    .addStringOption((option) =>
      option.setName('topic').setDescription('想被問的主題，不填由小吉自己挑').setMaxLength(100)
    ),

  async execute(interaction) {
    await executeStudentCommand(interaction);
  },
};
